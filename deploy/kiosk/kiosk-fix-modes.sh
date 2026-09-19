#!/bin/bash
# Re-probe the kiosk displays and pin the intended modes. Safe to run repeatedly:
# every branch is a no-op when the output is already in an acceptable mode, so
# this is both the ExecStartPost fixup and a periodic guard (see
# kiosk-fix-modes.timer).
#
# On a cold boot the TV/monitor frequently has not completed its HDMI handshake
# by the time X starts, so the driver validates no EDID and falls back to a
# generic 1024x768 (4:3) mode, which crushes the 16:9 dashboard layout into
# overlapping text. Re-probing AFTER X is running recovers the real EDID.
# The script retries for RETRY_S and logs every decision.
#
# Deliberately does NOT use CustomEDID/ConnectedMonitor overrides: a stale
# override is a reliable way to get a full day of "no signal".
#
# Configure with environment variables (or edit the defaults):
#   OUT0=HDMI-0      xrandr output name on screen :0.0 (the wall)
#   OUT1=HDMI-0      xrandr output name on screen :0.1 (the second screen)
#   WANT1=3840x2160  the second screen's intended mode; RATE1=59.94 its rate
#   RETRY_S=300      how long to keep re-probing screen 0

RETRY_S=${RETRY_S:-300}
OUT0=${OUT0:-HDMI-0}
OUT1=${OUT1:-HDMI-0}
WANT1=${WANT1:-3840x2160}
RATE1=${RATE1:-59.94}
log() { echo "$(date '+%F %T') $*"; }

XAUTH=$(ls -t /tmp/serverauth.* 2>/dev/null | head -1)
if [ -z "$XAUTH" ]; then log "no /tmp/serverauth.* - X not up, giving up"; exit 0; fi
export XAUTHORITY="$XAUTH"

for _ in $(seq 1 30); do
    DISPLAY=:0.0 xdpyinfo >/dev/null 2>&1 && break
    sleep 2
done

cur_mode() { DISPLAY=$1 xrandr 2>/dev/null | awk '/\*/{print $1; exit}'; }
# refresh rate of the active mode (the field carrying the *), e.g. 59.94
cur_rate() { DISPLAY=$1 xrandr 2>/dev/null | awk '/\*/{for(i=2;i<=NF;i++) if($i ~ /\*/){gsub(/[*+]/,"",$i); print $i; exit}}'; }
has_mode() { DISPLAY=$1 xrandr 2>/dev/null | grep -q "   $2"; }

# --- Screen 1: second screen (TV) -------------------------------------------------
# Some panels advertise their 4K mode at 30 Hz as EDID-preferred, so "resolution is
# right" is not enough: a re-probe can legitimately land on 4K30 and halve the rate.
if DISPLAY=:0.1 xdpyinfo >/dev/null 2>&1; then
    tv_rate=$(cur_rate :0.1); tv_rate_ok=$(awk -v r="${tv_rate:-0}" 'BEGIN{print (r+0 >= 59) ? 1 : 0}')
    if [ "$(cur_mode :0.1)" = "$WANT1" ] && [ "$tv_rate_ok" = "1" ]; then
        log "screen1 already $WANT1 @ ${tv_rate}Hz"
    else
        if ! has_mode :0.1 "$WANT1"; then
            # off/auto forces the driver to re-read EDID; only worth doing when the mode is absent
            log "screen1 wrong mode/rate (${tv_rate:-none}Hz) - re-probing EDID"
            DISPLAY=:0.1 xrandr --output "$OUT1" --off 2>/dev/null
            sleep 2
            DISPLAY=:0.1 xrandr --output "$OUT1" --auto 2>/dev/null
            sleep 3
        fi
        if has_mode :0.1 "$WANT1"; then
            DISPLAY=:0.1 xrandr --output "$OUT1" --mode "$WANT1" --rate "$RATE1" 2>/dev/null
            DISPLAY=:0.1 nvidia-settings --assign \
                "CurrentMetaMode=$OUT1: ${WANT1}_${RATE1} +0+0 {ForceFullCompositionPipeline=On, ForceCompositionPipeline=On}" \
                >/dev/null 2>&1
            log "screen1 -> $WANT1 (now $(cur_mode :0.1))"
        else
            log "screen1 still offers no $WANT1 mode - left at $(cur_mode :0.1)"
        fi
    fi
else
    log "screen1 not present - single-screen kiosk"
fi

# --- Screen 0: the wall ------------------------------------------------------------
# Prefer true 1920x1080. 1600x900 and 1366x768 are acceptable fallbacks (all 16:9,
# so the layout survives); 1024x768 is NOT - it is the 4:3 no-EDID default.
# Never leave this output off: it is the primary.
deadline=$(( $(date +%s) + RETRY_S ))
while :; do
    now=$(cur_mode :0.0)
    # Accept ANY 16:9 mode (within rounding) so this never fights a deliberate
    # choice; only the 4:3 no-EDID fallback is treated as broken.
    if [ -n "$now" ] && echo "$now" | grep -qE '^[0-9]+x[0-9]+$'; then
        w=${now%x*}; h=${now#*x}
        if [ "$h" -gt 0 ] && [ $(( w * 1000 / h )) -ge 1700 ] && [ $(( w * 1000 / h )) -le 1850 ]; then
            log "screen0 already 16:9 at $now"; break
        fi
    fi
    picked=""
    for want in 1920x1080 1600x900 1366x768; do
        if has_mode :0.0 "$want"; then
            if DISPLAY=:0.0 xrandr --output "$OUT0" --mode "$want" 2>/dev/null; then
                picked="$want"; break
            fi
        fi
    done
    if [ -n "$picked" ]; then log "screen0 $now -> $picked"; break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
        log "screen0 stuck at $now - no 16:9 mode offered within ${RETRY_S}s"
        break
    fi
    # a query re-probes the output; the EDID often turns up seconds-to-minutes after boot
    DISPLAY=:0.0 xrandr --query >/dev/null 2>&1
    sleep 10
done

exit 0
