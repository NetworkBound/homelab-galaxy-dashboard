"""galaxy_assets.py - bake the dashboards' universe: sky, spiral discs, planets,
star and courier craft. Deterministic, headless, numpy-only.

    python3 galaxy_assets.py --out DIR [--also REPO_DIR --also-size 1024]
                             [--sky 4096] [--disc 2048] [--planet 2048]
                             [--only sky,discs,planets,rocket]

    # the historical entry point still works; Blender is no longer required
    blender -b --python galaxy_assets.py -- --out DIR

WHY THERE IS NO BLENDER IN HERE ANY MORE
----------------------------------------
The previous generator drove Cycles and EEVEE through shader node graphs. Every one
of these assets is either a 2D field over a sphere/disc or a hard-budgeted triangle
list, so the renderer was doing nothing that numpy cannot do directly, while costing
all the control that matters here: exact per-channel extinction curves, exact
luminance targets against a known bloom threshold, exact vertex counts, and
bit-reproducibility from a seed. Direct synthesis also runs the whole bake in about
four minutes on CPU with no colour-management surprises. The `blender -b --python`
entry point is preserved, and image writing falls back to Blender's own writer if
Pillow is missing, so nothing downstream had to change.


TECHNIQUE PER ASSET
===================

sky.jpg  (equirect 2:1, dim, JPEG)
----------------------------------
Was: four fBm noise veils multiplied together. No stars, no composition, uniformly
busy everywhere -- it read as coloured fog.

Now, in order of how much each one matters:

* A GALACTIC PLANE with the right internal structure. The band is the analytic
  integral of an exponential stellar disc seen from inside it (h_z = 300 pc),
  attenuated by a SECOND exponential disc of dust (h_dust = 125 pc). The entire
  appearance of the Milky Way follows from dust being 2.4x thinner than stars:
  along b = 0 you look down the dust lane and it is thick for a kiloparsec, but a
  few degrees off-plane you climb out of the dust while still cutting through
  plenty of stars, so the surface brightness peaks OFF the midplane (at about
  b = 3 deg, 5 deg toward the centre). A single-scale-height model gives a smooth
  featureless streak, which is what most procedural skies look like. Longitude
  weighting makes it bright and wide toward the centre and thin toward the
  anticentre, so the frame has an axis and a subject.

  The stars are EMBEDDED IN the dust, not behind it, and that is now solved
  properly instead of as (disc integral) * exp(-tau_total). Multiplying the whole
  integral by the total optical depth sends the midplane to exactly zero, and the
  plate baked out as a black snake with a thin glowing rim rather than as a band
  -- the dust was eating precisely the part that was supposed to glow. The
  correct transfer, with the emissivity and the opacity both exponential in z,

      I = (j0 h_dust / mu) e^-T Integral_0^1 u^(p-1) e^(Tu) du,   p = h_d/h_s

  is tabulated once in `_slab_table`. It tends to the unobscured disc integral
  j0 h_star/mu as T -> 0 and SATURATES at the source function j0/alpha0 as
  T -> inf, which is why the real midplane is bright. The off-plane peak survives;
  the midplane now sits 28% below it instead of at zero.
* A DARK RIFT: a narrow (sigma 6 deg) lane of domain-warped ridged noise, plus six
  named, discrete, SHARP-EDGED dark nebulae silhouetted on the band at A_V = 3.5
  to 7. Smooth extinction is a continuum and can only read as haze; what makes the
  real Milky Way look three-dimensional is that the Coalsack and the Pipe have
  edges you can point at and are genuinely opaque. Their shape is therefore a hard
  threshold on warped ridged noise and not a soft envelope. All of it is applied as
  PER-CHANNEL extinction over the band, the nebulae and the faint stars alike --
  but NOT over the brightest stars, which are in the foreground.
* DEPTH: ~50 distant galaxies and two Magellanic-analogue satellites. A star is a
  point at an unknowable distance; a resolvable disc is unmistakably far away, and
  a few of them turn the sky from a wall into a volume. They respect the ZONE OF
  AVOIDANCE (none within 16 deg of the plane, because that is where the dust is --
  sprinkling them evenly across the band is the giveaway), they carry Sersic
  profiles and random position angles so they never read as stars, and the
  flattened ones get a dust lane down the major axis. The satellites are drawn as
  resolved star clouds with an off-centre bar and one giant HII complex each,
  because at this plate scale a nearby satellite would not be smooth.
* A REAL STAR POPULATION. Counts follow the observed N(<m) ~ 10^(0.49 m), not the
  10^(0.6 m) of a homogeneous universe, so flux is sampled from P(F>f) ~ f^-1.225.
  Spectral types are drawn from the MAGNITUDE-limited mix (O 0.6 / B 19.6 / A 21.7
  / F 14.3 / G 13.3 / K 24.6 / M 6.0 percent), not the volume-limited one -- by
  volume 76% of stars are M dwarfs, but in a visible sky OBA are ~42% and M is 6%,
  because an O star is sampled over a volume a million times larger. Getting this
  backwards is what makes a procedural starfield look orange instead of
  blue-white. Colours come from a Planckian locus fit, desaturated, because the
  entire stellar gamut only spans #ffb969 to #a5baff. Stars are splatted as
  ellipses stretched 1/cos(lat) in x so they stay round on the sphere, with a
  broad faint halo on the brighter half (the halo, not the core, is what makes a
  star look like a star). The brightest twenty-two get a second, much wider halo
  and real diffraction spikes: chains of overlapping gaussians laid along an
  arbitrary direction, so they are sub-pixel accurate at any angle, with a 1/r
  profile along the arm (which is why real spikes carry so far) and a reddening
  outward (the diffraction angle scales with wavelength). All the arms share one
  roll angle, because a spider rotates with the telescope. Writing integer pixels
  along a row and a column, as the previous version did, can only draw an upright
  cross and staircases visibly at 4K.
* NEBULAE from two-level domain-warped RIDGED noise, not plain fBm -- plain fBm
  has no thin bright structures and can only ever be fog. Each complex carves a
  cavity out of its own density field and brightens the cavity SHELL, which is
  the cheap stand-in for the limb brightening that makes real emission nebulae
  read as hollow rather than solid. Density goes through a threshold-and-power
  transfer curve before emission, because noise with mean 0.5 literally is grey
  fog; the target is a histogram that is mostly black. The five complexes are
  separated in longitude and each is dominated by a different mechanism (OIII
  teal, H-alpha rose, dusty amber reflection) rather than all being pink.

Luminance is measured, not eyeballed: the runtime tints this plate by 0x333333 and
its bloom threshold is 0.78, so the bake reports mean / median / p99 / p99.9 and the
fraction over threshold every time it runs.

One deliberate stylisation: the real Milky Way is only about 2.5x brighter than the
darkest sky. That is too subtle to carry a frame, so the band is gamma-lifted. It is
one line and it is labelled.


galaxy_*.png  (square RGBA, straight alpha, transparent outside 0.9R)
---------------------------------------------------------------------
Was: sin(theta*arms + k*ln r) plus noise. Mushy, no real dust lanes, blown core,
and it took three attempts to stop it rendering as a filled circle.

Now:

* Arms live in LOG-POLAR space. psi = m*theta/2pi + ln(r)/(2pi tan i) is a straight
  stripe pattern there, so the pitch angle i is constant by construction -- a true
  logarithmic spiral. The nested-rotated-ellipse model (the other standard approach)
  is Archimedean, not logarithmic, and its pitch runs from ~50 deg at the core to
  ~11 deg at the rim, which is why its inner arms always look over-open.
  Crucially, frac(psi) is also the signed ACROSS-ARM coordinate, which makes the
  physically correct offsets nearly free -- and round(psi) NAMES THE ARM, which is
  what lets each arm carry its own amplitude and its own truncation radius.
* Those offsets, in order across an arm: DUST LANE on the concave/inner edge (inside
  corotation the gas overtakes the arm from behind and shocks there), then the
  stellar ridge, then the HII knots a few hundred parsecs downstream.
* Dust extinction is applied PER CHANNEL through an R_V = 3.1 curve
  (A_lambda/A_V = 0.75 / 1.00 / 1.32 for R/G/B), so the lanes REDDEN as well as
  darken. Multiplying by a neutral grey is the classic tell of a fake galaxy.
* HII knots are pink H-alpha gaussians with a white OB-association core at a tenth
  of the diameter, diameters from a d^-4 law and luminosities from a -2 power law.
  Pink blobs with white cores strung like beads along the outer edge of a dark
  reddish lane is the single most recognisable signature a spiral arm has.
* Two separate resolved-star populations sampled from DIFFERENT fields: young blue
  ones confined to the arms, old pale ones following the smooth bulge+disc and the
  bar. Both are extincted by the same dust map. This matters more than it sounds:
  the broadband arm/interarm colour difference in real galaxies is under 0.1 mag in
  B-V, so the "blue arms" read has to come from resolved young stars and HII, not
  from painting the arms blue. A smoothly blue arm on a yellow disc looks like a
  poster. The plate ships at 1024 after a 2x box downscale, so the stars are
  splatted at ~1.9 px here (about 1 px shipped) and there are correspondingly fewer
  of them. At the old 1.2 px they were 0.6 px shipped, i.e. below the sampling
  limit, so the "resolved" star field averaged into exactly the smooth coloured
  veil it was supposed to replace -- the same failure arriving by a different road.
* HII knots are CLUSTERED along the arm, with the weighting following the
  star-formation rate per unit area (which peaks near 0.4 R25 and falls inward).
  The observed two-point correlation of HII regions is strong out to ~500 pc, so a
  real arm is beads in groups separated by long dark gaps; a uniform string of
  beads is a giveaway. The few giant complexes that a steep luminosity function
  guarantees get a wide faint skirt, because at a distance it is the skirt and not
  the core that makes an arm look beaded.
* A BAR, because about two thirds of nearby spirals have one and it is the first
  thing the eye uses to tell a real galaxy from a pinwheel. Boxy isophotes (the
  generalised-ellipse exponent is measured at 2.5-3.5 for strong bars, against 2.0
  for an ellipse), a flat-topped light profile with a sharp end, two dust lanes on
  the leading edges meeting at the nucleus in a shallow S, star-forming hotspots at
  both ends and a nuclear ring of HII where the bar has driven the gas. The arm
  phase is LOCKED so that psi is an integer at the bar end, which makes the arms
  spring from the bar instead of floating free; inside the bar radius the spiral is
  gated almost off, because that gas is on x1 orbits.
* ASYMMETRY, three independent ways, because an m-fold pattern is exactly m-fold
  symmetric and a two-armed one reads as a logo. (1) A tidal m=1 azimuthal shear
  growing as r^2 -- the leading-order effect of a companion -- which winds one arm
  tighter and unwinds the other, since sin(th - pa) has opposite sign at th and
  th + pi. (2) Per-arm amplitude and truncation radius, keyed off round(psi); the
  label switches at the interarm minimum where the stripe is ~0, so the switch is
  invisible. (3) A one-sided tidal plume in the outer disc.
* GLOBULAR CLUSTERS in the halo: a cored projected power law inverted analytically,
  a log-normal luminosity function (the GCLF is gaussian in MAGNITUDE, peak
  M_V = -7.4, sigma 1.2, so a handful are much brighter than the rest and they do
  not read as a dot screen), marginally resolved, with a blue metal-poor
  subpopulation. They matter out of all proportion to their light: they are the one
  population living OUTSIDE the disc, so they are what says the galaxy is a
  three-dimensional object rather than a decal.
* The disc now ENDS IN AN ENVELOPE instead of stopping. The light profile is simply
  carried further out, arms and flocculence and resolved stars and all, until the
  alpha window takes over. An axisymmetric halo added on top was tried and
  rejected: any profile faint enough not to lift the interarm floor is invisible
  outside it, and the ring-shaped compromise read as a soap bubble.
* Light profile is a Sersic n=2 bulge at R_e = 0.2h (a very stable observed ratio)
  plus a double-exponential Type II disc with the break at 2.5h and the outer scale
  length halved -- about 60% of real spirals are Type II, and it is what makes the
  disc END rather than fade forever, which the 0.9R transparency rule requires.
* Structure is broken up the way real discs are: a weak m=3 component, m=1
  lopsidedness at the observed A1 ~ 0.13, high-pitch spurs downstream of the arms,
  grain-scale clumping, and radius-dependent flocculence so the outer disc goes
  patchy while the inner disc stays grand-design. The interarm FLOOR falls with
  radius too: held constant it is what produced the featureless outer haze (teal in
  the cyan plate, brown in the amber one), because out there the smooth disc is all
  that is left and the stretch lifts it straight back to visible.
* The three plates are three de Vaucouleurs CLASSES, not three colourways of one
  shape -- SB(s)bc, SB(r)b and an interacting SABa. They are seen together in the
  wide shots, where identical structure under different accents reads as a repeat.
* Output is stretched by dividing out a fractional power of the smooth radial light
  profile before the tone curve. This is the standard astrophotographic stretch and
  it is the only way to fit a hot nucleus and faint outer arms into the same 8 bits.
  It is a per-radius scale, so it leaves the arm/interarm contrast untouched.

Two deliberate departures, both forced by the runtime: the interarm floor is ~4% of
the arm rather than the ~50% real discs show, because the dashboards draw live
point-star arms additively on top and the gaps have to be black; and the stellar
colour ramp ends are keyed to each node's accent colour instead of a blackbody
locus, though the gradient direction (warm core, cool arms) is real.

Plates are written TONE-MAPPED BUT NOT sRGB-ENCODED, because the renderer runs with
NoToneMapping and no output encoding and only grades at the very end (ACES at
exposure 1.45). RGB is forced to zero wherever alpha is zero: with straight alpha
and mipmapping, bright RGB under zero alpha bleeds out as a square halo as soon as
the texture is minified.


planet_*.png  (equirect 2:1, opaque)
-------------------------------------
Was: sin(latitude) bands with warp noise. Flat, no storms, no surface interest.

Now:

* Everything is sampled from the 3D direction vector on the unit sphere, never from
  uv. That is what makes these seamless in longitude and undistorted at the poles;
  the old maps sampled 2D uv noise and had features squashed into arcs near the
  poles plus a visible wrap seam.
* THE POLES. Sampling in 3D is necessary and was not sufficient; the caps still
  baked out as mush. Three separate causes, all now fixed:
    - Perlin noise is IDENTICALLY ZERO at every lattice vertex and the pattern
      around one carries the lattice's own four-fold symmetry. Sphere fields are
      sampled as (x*f, y*f, z*f) with f an integer, so the six axis directions --
      which include both poles -- landed exactly on a vertex at every octave. That,
      not "equirect mush", is why the ice giant's cap was a grey blob with a
      visibly octagonal edge. `_LATTICE_OFF` displaces the whole field by an
      irrational vector; one add, and it fixes the artefact everywhere at once.
    - An equirect plate stores w samples around every parallel, but the parallel at
      latitude b is only 2*pi*cos(b) long, so it carries 1/cos(b) times more
      longitudinal detail than the sphere can hold -- 40x too much ten degrees out,
      unbounded at the pole. Hardware aniso is capped at 8x here, so the excess
      aliases, the isotropic mip fallback over-blurs, and three.js's degenerate
      pole triangles smear whatever w colours sit in the top row into a pinwheel.
      `polar_bandlimit` low-passes each row at k_max = (w/2) cos(lat), which is the
      only filter that addresses it because the problem is anisotropic. The pole
      rows keep only DC -- their own mean, which IS the pole colour.
    - There was nothing to look at. The caps now carry a domain-warped two-regime
      turbulent field and the circumpolar CYCLONE RING that Juno found: eight
      storms plus a central one in the north, five in the south, near-touching, in
      a polygonal ring, each with a two-armed spiral and a calm eye. Computed from
      3D dot products against each storm's own axis and its own local frame, never
      from lat/lon, which is the thing that goes singular there. Scaled up about 2x
      from Jupiter's real 3.8 deg storms at colatitude 7 deg, for the same reason
      the granulation and the jet amplitudes are: these bodies are 15-40 px.
* Bands come from Jupiter's MEASURED zonal jet profile (the BAA/Rogers averaged jet
  table) rather than a sinusoid. This is not pedantry: a single sinusoid explains
  only about 26% of the variance in Jupiter's real zonal brightness profile. The
  jets are irregularly spaced (mean 6.8 deg, range 3.4-12.3) and the prograde ones
  are stronger and narrower than the retrograde ones, and that irregularity and
  asymmetry is most of what stops procedural bands looking like wallpaper.
* Zones and belts are selected by the SIGN OF THE SHEAR (anticyclonic = bright
  zone), not by latitude, so band edges automatically land on the jet peaks.
* Band edges MEANDER, by 2-4 degrees RMS with power at zonal wavenumbers 1-5 and
  14-21. Perfectly straight band edges are the single biggest procedural-planet
  tell there is, and the meander is applied before any lookup so the colour stamp,
  the jet profile and the detail all stay registered to the same wandering edge.
* Detail is noise ADVECTED along the jets: sampled after transporting the point
  backwards along the flow for several different times and summed. Long transport
  means more shear means longer thinner filaments, which is what produces the
  Jovian look of broad smooth zones carrying very long streaks that curl up at the
  shear boundaries. Advection time scales with the local |du/dy|, matching the
  measured eddy anisotropy of 2:1 near the poles up to 10:1 in the strongest belts.
* The detail fBm uses a TWO-REGIME gain (0.88 at large scales, 0.55 below the
  knee) because measured Cassini cloud-brightness power spectra go as n^-1.3 then
  n^-2.75. Plain gain-0.5 fBm is far too red at large scales, which is exactly why
  naive procedural gas giants come out soft and blobby.
* Vortices are a rotational domain warp inside an ellipse, so the surrounding
  filaments get DRAGGED around them -- a storm painted as an isolated ellipse on
  top of the bands reads as a sticker. The hero oval is hollow (tangential speed
  peaks at the rim, near zero in the core, as the Great Red Spot's does), sits at
  22S in a shear gap, has aspect ~1.35 and is tinted terracotta rather than
  crimson, which is its actual colour.
* Poleward of about 50 degrees the zonal structure is blended out, because that is
  what the measured eddy aspect ratio does, and the chromophores go with it: the
  measured polar hoods are grey to bluish, and leaving the warm tint on under the
  cap is what made the old one look like dirty cream. The cap gets a distinct
  collar at its boundary, so it reads as a cap rather than as a fade-out.
* The third body is a terrestrial world instead of a third giant: continents at
  genuinely continental scale, banded cloud, polar caps, and auroral ovals as
  OFFSET RINGS around the magnetic poles rather than caps. At 9-15 px on screen,
  large-scale contrast is the only thing that survives.

These maps are written as high-mean (~0.7), mostly-neutral luminance maps with only
mild hue variation, because the runtime MULTIPLIES them into an already-tinted body
colour (`col *= texture(uMap, uv).rgb * 1.15`). The old maps were fully saturated
orange/blue/green and multiplied with the accent into a muddy double-tint. Jupiter
is in any case far less saturated than it is usually painted -- median Oklab chroma
about 0.017.


sun.png  (equirect 2:1, opaque)
--------------------------------
Was: Voronoi cells. Read as a golf ball.

Now:

* Intergranular lanes come from Quilez's distance-to-the-perpendicular-bisector,
  d = dot(0.5*(ca+cb), normalize(cb-ca)), not from F1 and not from F2-F1. F1 alone
  gives exactly the puffy golf ball the old map had. F2-F1 is not a distance -- it
  expands and contracts with the local spacing of the feature points, so lane width
  wanders and it collapses at triple junctions. The bisector distance is a true
  distance, so lanes come out at constant thickness, which is what the real
  photosphere shows (200-300 km lanes on a ~1360 km cell pitch, covering about a
  third of the surface).
* Supergranulation is NOT painted as cells. Its thermal contrast is 7.8e-4, some
  200x weaker than granulation and completely invisible in intensity. What you
  actually see at that scale is the magnetic network riding on the cell BOUNDARIES,
  so only the boundaries are drawn, only as brightening, and strongest at active
  latitudes where it becomes plage.
* Sunspots are the feature that makes a sphere read as a star rather than a
  textured ball, so the budget goes there. Umbra at 0.235 of the quiet photosphere,
  penumbra at 0.768, umbral radius 0.45 of the spot radius (total area = 5x umbral
  area), placed on a butterfly diagram (latitudes 28 deg early in a cycle down to
  7 deg late) with Joy's law tilt and its full observed scatter. Penumbral
  filaments are made by radially warping the same granulation field, which keeps
  the dark parts multiply connected the way real penumbrae are.
* The umbra is ORANGE, not black. It is a cooler blackbody: at ~4400 K its
  per-channel ratio to the photosphere is about (0.29, 0.235, 0.165), i.e. blue is
  suppressed 2.2x more than red. That ratio is what makes a spot read as a warm
  ember rather than a drilled hole.
* LIMB DARKENING IS DELIBERATELY NOT BAKED IN. It is view-dependent: mu is measured
  against the observer, while an equirect texture's coordinates are rigidly attached
  to the rotating surface. Baked in, the dark ring stays glued to one patch of
  photosphere and travels around the disc as the star spins. The runtime's fresnel
  term supplies the limb behaviour instead.

One knowing departure from physics: the real Sun has about four million granules,
which at 8 px each would need a 25000x12000 map. The star renders at roughly 140 px,
so the granule count is cut to about 1100 and the lane contrast is pushed well below
the real 15.8% while the cell-to-cell brightness variation is pushed well above it --
the brightness variation survives downsampling, the lane network does not. Baking
the true granule scale produces shimmering noise, not granulation.

That weighting was right and it was not what the code did. "Cell-to-cell brightness
variation" was implemented as a plain fBm field with no relation to the Voronoi
cells, so every granule was in fact the same brightness and the ONLY thing
separating one from the next was the lane between them -- which is why the map still
read as crazing on an egg at 140 px, the same golf-ball failure in a different
costume. The cell index now comes back out of `voronoi_edge_equirect` and each
granule is hashed its own value, and the lane-breaking noise runs at half a cell
pitch instead of two, so the lane network is topologically broken rather than merely
uneven. (Full-strength per-cell values alone were tried and read as flat stained
glass; the shipped mix is a third cell-keyed, a sixth from the finer population and
half smooth.)


rocket.json  ({pos, nrm, col, glow, idx}, nose +Z)
---------------------------------------------------
Was: a cylinder, a cone and four cubes. 592 verts.

Now a lathe-and-plate model built by a small deterministic mesh kernel rather than
by a modifier stack, because the contract is a raw buffer with a hard triangle
budget and hand-authoring the bevels as explicit profile points gives exact control
of vertex count and crease placement.

The governing constraint is that the craft is ~14 world units in a scene thousands
of units across, so it is a few dozen pixels. Silhouette is everything and surface
detail is sub-pixel, so the budget goes on things that change the OUTLINE -- a long
ogive nose with two deliberate hull steps (a shoulder and a waist, so it reads as
built rather than turned), cranked-delta wings spanning four and a half hull radii,
wing-tip pods, ventral strakes and a flared nozzle -- and on a handful of emissive
points spread as WIDE as possible, because at small size the eye reads the
constellation of bright dots before it reads any shape. Hence red and green
navigation lights on the wing tips, 1.17 hull lengths apart.

Three additions over the first pass, all of them outline and none of them surface,
because at thirty pixels it still read as a generic delta:

* CANARDS. The one thing they add is a SECOND span forward of the main one. An
  outline that goes narrow-wide-narrow-wide-narrow along its length is read as a
  built vehicle; one that goes narrow-wide-narrow is read as a dart. Twenty
  triangles each.
* A V-TAIL instead of a single dorsal fin. A shark fin is a strong silhouette from
  the side and NOTHING from directly above or below, and these craft are flown
  along curves that put the camera everywhere; a V always shows two edges. It also
  widens the tail, which is how the eye tells front from back at this size, and it
  carries a white strobe on each tip -- so with the wing-tip pair there are now
  four emissive points at the four extremes of the outline.
* TWIN OUTBOARD NACELLES on short pylons. The camera sits astern for the whole
  outbound leg of every bridge run, and from there one bell on the axis is a dot
  while three in a triangle is a shape. Mass outboard and low is also most of what
  separates a hauler from a fighter in one glance.

Emissive trim strips FOLLOW the hull curvature (built from the same lathe profile
and pushed out radially) rather than being flat tangent plates, which read as
stickers glued on. The hull is deliberately dark, around 0.10-0.22 luminance,
because the runtime shader's ambient term is 0.22 and it has no tonemap of its own:
a light hull washes out and the trim stops reading as emissive.

Judged with a software rasteriser that reproduces the dashboard's rocket shader
exactly, including its fixed view-space key light and its glow term, at both full
size and 70 px -- judging it in any other lighting model would be judging the wrong
thing.


A NOTE ON JUDGING THESE
=======================
The renderer runs NoToneMapping with no output encoding and applies ACES at exposure
1.45 in a final pass, and the galaxy plates are additively blended at 0.4-0.6
opacity. So an asset opened in an image viewer is not the asset anyone will see.
Every plate here was judged through a simulation of that exact chain
(`runtime_grade` / `preview_additive`), and the RGBA plates were composited over
black first, because viewers ignore straight alpha.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

# `G` and `M` are how the sections below refer to the shared kernels. Binding them
# to this module keeps the development-time module split readable in one file.
G = M = sys.modules[__name__]


TAU = 2.0 * np.pi
LUMW = np.array([0.2126, 0.7152, 0.0722], np.float32)
# Milky Way R_V = 3.1 extinction, A_lambda/A_V at the R / V / B effective
# wavelengths. Dust must REDDEN as well as darken; a neutral grey multiply is
# the classic tell of a fake galaxy.
EXT_RGB = np.array([0.75, 1.00, 1.32], np.float32)

# ==========================================================================
# noise, colour and splatting kernel
# ==========================================================================

# --------------------------------------------------------------------------- hashing
# integer hash used for lattice gradients: deterministic, no permutation table,
# no python-level loops. Wang/xxhash-style avalanche on uint32.

_M1 = np.uint32(0x9E3779B1)
_M2 = np.uint32(0x85EBCA6B)
_M3 = np.uint32(0xC2B2AE35)


def _hash3(ix, iy, iz, seed):
    # uint32 wraparound IS the avalanche here, so the overflow is the algorithm and
    # not a bug. numpy only warns about it for 0-d operands, which is why the bake
    # log was noisy exactly for the fields that pass a constant z (fbm3(x, y, 0.3)).
    # errstate changes no value; verified by md5 of the plates either way.
    with np.errstate(over="ignore"):
        h = (ix.astype(np.uint32) * _M1) ^ (iy.astype(np.uint32) * _M2) ^ (iz.astype(np.uint32) * _M3)
        h ^= np.uint32((int(seed) * 0x27D4EB2F) & 0xFFFFFFFF)
        h ^= h >> np.uint32(15)
        h *= _M2
        h ^= h >> np.uint32(13)
        h *= _M3
        h ^= h >> np.uint32(16)
    return h


def hash01(ix, iy, iz, seed):
    """uniform [0,1) from three integer lattice coords."""
    return (_hash3(ix, iy, iz, seed) >> np.uint32(8)).astype(np.float32) * np.float32(1.0 / 16777216.0)


# 16 well-spread gradient directions (Perlin's improved-noise set, 3D)
_GRAD = np.array([
    (1, 1, 0), (-1, 1, 0), (1, -1, 0), (-1, -1, 0),
    (1, 0, 1), (-1, 0, 1), (1, 0, -1), (-1, 0, -1),
    (0, 1, 1), (0, -1, 1), (0, 1, -1), (0, -1, -1),
    (1, 1, 0), (0, -1, 1), (-1, 1, 0), (0, -1, -1),
], dtype=np.float32)


def _fade(t):
    # 6t^5 - 15t^4 + 10t^3  (C2 continuous; C1 fade shows lattice creases in fBm)
    return t * t * t * (t * (t * np.float32(6.0) - np.float32(15.0)) + np.float32(10.0))


# Perlin noise is IDENTICALLY ZERO at every lattice vertex, and the pattern around a
# vertex carries the lattice's own four-fold symmetry. Sphere fields are sampled as
# (x*f, y*f, z*f) with f usually an integer, so the six axis directions -- which include
# BOTH POLES -- land exactly on a lattice vertex at every octave. That is why the ice
# giant's polar cap was a grey blob with a visibly octagonal edge: it was not "equirect
# mush", it was the noise lattice showing through at (0, +-f, 0). Displacing the whole
# field by an irrational vector moves the poles off the lattice at every frequency and
# costs one add. Verified: perlin3 at (0,9,0) is exactly 0.000000 without this.
_LATTICE_OFF = (np.float32(0.3178), np.float32(0.5173), np.float32(0.7369))


def perlin3(x, y, z, seed=0):
    """3D gradient (Perlin) noise, roughly [-1,1]. Inputs are float32 arrays of any shape."""
    x = np.asarray(x, np.float32) + _LATTICE_OFF[0]
    y = np.asarray(y, np.float32) + _LATTICE_OFF[1]
    z = np.asarray(z, np.float32) + _LATTICE_OFF[2]
    xi = np.floor(x); yi = np.floor(y); zi = np.floor(z)
    xf = x - xi; yf = y - yi; zf = z - zi
    ix = xi.astype(np.int64); iy = yi.astype(np.int64); iz = zi.astype(np.int64)
    u = _fade(xf); v = _fade(yf); w = _fade(zf)

    def dot_at(dx, dy, dz):
        # Perlin's improved-noise gradient selection done with bit tests instead of a
        # table gather: a (H,W,3) fancy-index costs ~3x this on 8 Mpx arrays.
        h = _hash3(ix + dx, iy + dy, iz + dz, seed) & np.uint32(15)
        px = xf - np.float32(dx); py = yf - np.float32(dy); pz = zf - np.float32(dz)
        a = np.where(h < 8, px, py)
        b = np.where(h < 4, py, np.where((h == 12) | (h == 14), px, pz))
        a = np.where((h & 1).astype(bool), -a, a)
        b = np.where((h & 2).astype(bool), -b, b)
        return a + b

    n000 = dot_at(0, 0, 0); n100 = dot_at(1, 0, 0)
    n010 = dot_at(0, 1, 0); n110 = dot_at(1, 1, 0)
    n001 = dot_at(0, 0, 1); n101 = dot_at(1, 0, 1)
    n011 = dot_at(0, 1, 1); n111 = dot_at(1, 1, 1)
    x00 = n000 + u * (n100 - n000); x10 = n010 + u * (n110 - n010)
    x01 = n001 + u * (n101 - n001); x11 = n011 + u * (n111 - n011)
    y0 = x00 + v * (x10 - x00); y1 = x01 + v * (x11 - x01)
    return (y0 + w * (y1 - y0)) * np.float32(1.4)          # ~unit range


def fbm3(x, y, z, octaves=5, lac=2.0, gain=0.5, seed=0):
    """fractional Brownian motion, normalised to ~[-1,1]."""
    total = np.zeros_like(np.asarray(x, np.float32))
    amp, freq, norm = 1.0, 1.0, 0.0
    for o in range(octaves):
        total += np.float32(amp) * perlin3(x * freq, y * freq, z * freq, seed + o * 1013)
        norm += amp
        amp *= gain
        freq *= lac
    return total / np.float32(norm)


def ridged3(x, y, z, octaves=5, lac=2.0, gain=0.5, seed=0, sharp=1.0):
    """Ridged multifractal: 1-|n| per octave. Makes filaments/creases instead of blobs.

    This is the single biggest difference between 'fog' and 'nebula' -- plain fBm has
    no thin bright structures, ridged noise is nothing but thin bright structures.
    """
    total = np.zeros_like(np.asarray(x, np.float32))
    amp, freq, norm = 1.0, 1.0, 0.0
    prev = np.float32(1.0)
    for o in range(octaves):
        n = perlin3(x * freq, y * freq, z * freq, seed + o * 2029)
        r = np.float32(1.0) - np.abs(n)
        r = r * r
        total += np.float32(amp) * r * prev
        prev = np.clip(r * np.float32(sharp), 0.0, 1.0)
        norm += amp
        amp *= gain
        freq *= lac
    return total / np.float32(norm)


def billow3(x, y, z, octaves=5, lac=2.0, gain=0.5, seed=0):
    """|fBm| -- puffy, cumulus-like. Good for dust clumps."""
    total = np.zeros_like(np.asarray(x, np.float32))
    amp, freq, norm = 1.0, 1.0, 0.0
    for o in range(octaves):
        total += np.float32(amp) * np.abs(perlin3(x * freq, y * freq, z * freq, seed + o * 3079))
        norm += amp
        amp *= gain
        freq *= lac
    return total / np.float32(norm)


def warp3(x, y, z, amount=1.0, freq=1.0, octaves=4, seed=0):
    """Domain warp: displace the sample point by a vector noise field.

    q = p + amount * noise(p*freq).  Iterating this (warp of a warp) is what turns
    isotropic fBm into something with flow, swirls and coherent filaments; it is the
    standard trick from Inigo Quilez's 'domain warping' write-up.
    """
    dx = fbm3(x * freq, y * freq, z * freq, octaves, seed=seed + 11)
    dy = fbm3(x * freq, y * freq, z * freq, octaves, seed=seed + 707)
    dz = fbm3(x * freq, y * freq, z * freq, octaves, seed=seed + 1409)
    a = np.float32(amount)
    return x + a * dx, y + a * dy, z + a * dz


# --------------------------------------------------------------------------- worley
def worley_sphere(dirs, points, need=2):
    """Worley/Voronoi on the unit sphere by great-circle (chord) distance.

    dirs   (N,3) unit vectors, points (M,3) unit feature points.
    Returns the `need` smallest chord distances, shape (need, N).

    Done with a KD-ish bucketing on a coarse icosahedral-ish grid would be faster,
    but M is small enough (<20k) that a chunked brute force is simpler and exact --
    and exactness matters: the F2-F1 lane trick is very sensitive to near-ties.
    """
    N = dirs.shape[0]
    out = np.full((need, N), 4.0, np.float32)
    step = max(1, int(6e7 // max(1, points.shape[0])))
    for s in range(0, N, step):
        d = dirs[s:s + step]
        # chord^2 = 2 - 2*dot
        dots = d @ points.T
        dd = np.maximum(0.0, 2.0 - 2.0 * dots)
        k = min(need, dd.shape[1])
        part = np.partition(dd, kth=range(k), axis=1)[:, :k]
        part.sort(axis=1)
        out[:k, s:s + step] = np.sqrt(part, dtype=np.float32).T
    return out


def fibonacci_sphere(n, rng=None, jitter=0.0):
    """Evenly spread points on a sphere (golden-angle spiral), optionally jittered.

    A jittered Fibonacci set is a cheap blue-noise stand-in: far better than uniform
    random for cell textures, which otherwise get ugly clumps and voids.
    """
    i = np.arange(n, dtype=np.float64) + 0.5
    phi = np.arccos(1.0 - 2.0 * i / n)
    theta = np.pi * (1.0 + 5.0 ** 0.5) * i
    p = np.stack([np.sin(phi) * np.cos(theta), np.sin(phi) * np.sin(theta), np.cos(phi)], 1)
    if jitter and rng is not None:
        p = p + rng.normal(0.0, jitter, p.shape)
        p /= np.linalg.norm(p, axis=1, keepdims=True)
    return p.astype(np.float32)


# --------------------------------------------------------------------------- geometry
def equirect_dirs(w, h, dtype=np.float32):
    """Unit direction per pixel of a 2:1 equirectangular image.

    Sampling the *sphere* (not the uv plane) is what makes an equirect map seamless in
    longitude and undistorted at the poles -- the old maps sampled 2D uv noise, so the
    features were squashed into arcs near the poles and had a visible wrap seam.
    y is up (the pole axis), matching three.js SphereGeometry's uv convention:
    u=0 at -x wrapping +z, v=0 at the south pole.
    """
    u = (np.arange(w, dtype=dtype) + 0.5) / w
    v = (np.arange(h, dtype=dtype) + 0.5) / h
    lon = (u * 2.0 - 1.0) * np.float32(np.pi)
    lat = (0.5 - v) * np.float32(np.pi)                # +pi/2 top row .. -pi/2 bottom
    cl = np.cos(lat)[:, None]
    x = (cl * np.sin(lon)[None, :]).astype(dtype)
    y = np.repeat(np.sin(lat)[:, None], w, 1).astype(dtype)
    z = (cl * np.cos(lon)[None, :]).astype(dtype)
    return x, y, z, lat, lon


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a + 1e-12), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def polar_bandlimit(img, keep=1.15, soft=0.35):
    """Low-pass an equirect plate in LONGITUDE at the sphere's own cos(lat) Nyquist.

    An equirect map stores w samples around every parallel, but the parallel at
    latitude b is only 2*pi*cos(b) long. The plate therefore carries 1/cos(b) times
    more longitudinal detail than the sphere can hold -- 40x too much ten degrees from
    the pole, unbounded at the pole itself. Three consequences, all of them visible:

    * The pole is a RANKED SINGULARITY in the uv parameterisation. three.js's
      SphereGeometry fans degenerate triangles into it, each sampling a different u at
      v = 0, so whatever w different colours sit in the top texel row get smeared into
      a pinwheel at the exact pole.
    * Hardware anisotropic filtering is capped (this runtime asks for 8x), so near the
      pole the sample footprint is far wider in u than the hardware will integrate and
      the excess detail aliases; the isotropic mip fallback over-blurs instead. Either
      way it reads as mush, which is exactly the complaint.
    * The texels are wasted: detail written there cannot survive to the screen.

    Band-limiting each row to k_max = (w/2) * cos(lat) fixes all three at once, and it
    is the only filter that does, because the problem is anisotropic and every
    image-space blur is not. The pole rows keep only DC, i.e. their own mean -- which
    IS the correct pole colour, being the limit of the average round a shrinking circle.
    `keep` > 1 leaves the equator untouched rather than softening the whole plate.
    """
    a = np.asarray(img, np.float32)
    flat = a.ndim == 2
    if flat:
        a = a[..., None]
    h, w = a.shape[:2]
    lat = (0.5 - (np.arange(h, dtype=np.float64) + 0.5) / h) * np.pi
    kmax = np.maximum(keep * (w * 0.5) * np.cos(lat), 0.0)[:, None]
    k = np.broadcast_to(np.arange(w // 2 + 1, dtype=np.float64)[None, :], (h, w // 2 + 1))
    gain = 1.0 - smoothstep((1.0 - soft) * kmax, kmax + 1e-9, k)
    gain[:, 0] = 1.0                                    # DC always survives
    out = np.empty_like(a)
    for r0 in range(0, h, 256):                         # chunked: a 4k plate's full
        r1 = min(h, r0 + 256)                           # complex spectrum is ~200 MB
        spec = np.fft.rfft(a[r0:r1].astype(np.float64), axis=1) * gain[r0:r1, :, None]
        out[r0:r1] = np.fft.irfft(spec, n=w, axis=1).astype(np.float32)
    return out[..., 0] if flat else out


def srgb_encode(lin):
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1.0 / 2.4) - 0.055)


def srgb_decode(s):
    s = np.clip(s, 0.0, 1.0)
    return np.where(s <= 0.04045, s / 12.92, np.power((s + 0.055) / 1.055, 2.4))


# --------------------------------------------------------------------------- colour
def blackbody_rgb(t_kelvin):
    """Planckian locus -> linear sRGB, normalised so max(channel)=1.

    Analytic CIE 1931 fit (Wyman/Sloan/Shirley 2013 gaussian approximation of the
    colour matching functions) integrated against Planck's law. Accurate enough for
    1000-40000 K and, unlike the usual Tanner Helland byte formula, it is smooth and
    works in linear light -- which matters because these values get additively blended.
    """
    t = np.atleast_1d(np.asarray(t_kelvin, np.float64))
    lam = np.linspace(380e-9, 780e-9, 81)[None, :]
    c1, c2 = 3.7418e-16, 1.4388e-2
    spec = c1 / (lam ** 5 * (np.exp(c2 / (lam * t[:, None])) - 1.0))

    def g(x, mu, s1, s2):
        s = np.where(x < mu, s1, s2)
        return np.exp(-0.5 * ((x - mu) / s) ** 2)

    nm = lam * 1e9
    xb = 1.056 * g(nm, 599.8, 37.9, 31.0) + 0.362 * g(nm, 442.0, 16.0, 26.7) - 0.065 * g(nm, 501.1, 20.4, 26.2)
    yb = 0.821 * g(nm, 568.8, 46.9, 40.5) + 0.286 * g(nm, 530.9, 16.3, 31.1)
    zb = 1.217 * g(nm, 437.0, 11.8, 36.0) + 0.681 * g(nm, 459.0, 26.0, 13.8)
    X = (spec * xb).sum(1); Y = (spec * yb).sum(1); Z = (spec * zb).sum(1)
    s = X + Y + Z
    X, Y, Z = X / s, Y / s, Z / s
    r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
    g_ = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
    b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z
    rgb = np.stack([r, g_, b], 1)
    rgb = np.clip(rgb, 0.0, None)
    rgb /= rgb.max(1, keepdims=True) + 1e-9
    return rgb.astype(np.float32)


# --------------------------------------------------------------------------- splatting
def splat_gauss(img, xs, ys, rx, ry, amp, colours, cutoff=3.0, wrap_x=False):
    """Additively splat anisotropic gaussians. img (H,W,3) float32, modified in place.

    Anisotropic because on an equirect map a round spot on the sphere is an ellipse
    stretched by 1/cos(lat) in x; passing rx = r/cos(lat) keeps stars and storms round
    on the actual sphere.
    """
    H, W = img.shape[:2]
    for i in range(len(xs)):
        cx, cy = float(xs[i]), float(ys[i])
        sx, sy = float(rx[i]), float(ry[i])
        if sx <= 0 or sy <= 0:
            continue
        hx = int(np.ceil(sx * cutoff)); hy = int(np.ceil(sy * cutoff))
        if hx > W:
            hx = W
        y0 = max(0, int(cy) - hy); y1 = min(H, int(cy) + hy + 1)
        if y1 <= y0:
            continue
        yy = np.arange(y0, y1, dtype=np.float32)
        gy = np.exp(-0.5 * ((yy - cy) / sy) ** 2)[:, None]
        xs0 = int(cx) - hx; xs1 = int(cx) + hx + 1
        xx = np.arange(xs0, xs1, dtype=np.float32)
        gx = np.exp(-0.5 * ((xx - cx) / sx) ** 2)[None, :]
        patch = (gy * gx)[:, :, None] * (np.asarray(colours[i], np.float32) * np.float32(amp[i]))
        cols = np.arange(xs0, xs1)
        if wrap_x:
            cols = np.mod(cols, W)
        else:
            m = (cols >= 0) & (cols < W)
            cols = cols[m]; patch = patch[:, m]
            if cols.size == 0:
                continue
        np.add.at(img, (slice(y0, y1), cols), patch)
    return img


# --------------------------------------------------------------------------- runtime sim
def runtime_grade(rgb, exposure=1.45, sat=1.12):
    """The dashboards' exact post chain: c = aces(c * 1.45), then saturation 1.12.

    Judging any of these plates in a plain image viewer is judging the wrong image.
    The renderer runs with NoToneMapping and no output encoding, so the bytes in the
    texture are fed straight into an additive blend and only graded at the very end --
    which means the textures must be written TONE-MAPPED but NOT sRGB-encoded.
    """
    c = np.asarray(rgb, np.float32) * np.float32(exposure)
    c = np.clip((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0)
    lum = c @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    return np.clip(lum[..., None] + (c - lum[..., None]) * sat, 0.0, 1.0)


def preview_additive(rgb, alpha=None, opacity=1.0, bg=0.0):
    """Composite a plate the way the runtime does (additive, src*alpha*opacity) and grade."""
    src = np.asarray(rgb, np.float32)
    if alpha is not None:
        src = src * np.asarray(alpha, np.float32)[..., None]
    return runtime_grade(src * opacity + bg)


def tonemap(lin, gain):
    """Exposure + soft shoulder in LINEAR light before writing the 8-bit plate.

    1-exp(-gain*L) keeps the ratio between arm and interarm almost intact at the dark
    end (unlike a gamma curve, which lifts the interarm into grey haze) while rolling
    the nucleus off smoothly instead of clipping it to a flat white disc.
    """
    return 1.0 - np.exp(-np.asarray(lin, np.float32) * np.float32(gain))


def voronoi_edge_equirect(h, w, points, k=10, band_rows=16):
    """Spherical Voronoi EDGE distance on an equirect grid, plus F1.

    Uses Inigo Quilez's distance-to-the-perpendicular-bisector rather than F2-F1:

        d = dot( 0.5*(ca + cb), normalize(cb - ca) )

    F2-F1 is not a distance -- it expands and contracts with the local spacing of the
    feature points, so a fixed smoothstep on it gives borders whose apparent width
    wanders, and it collapses at triple junctions. The bisector distance is a true
    distance, so the intergranular lanes come out at CONSTANT thickness, which is what
    the real photosphere shows.

    Returns (edge distance, F1 distance, owning-seed index).

    Accelerated by processing the image in latitude bands and, per band, testing only
    the feature points that could reach it. Brute force over the whole sphere would be
    a 6e9-element intermediate; this keeps it under a hundred megabytes.
    """
    pts = np.asarray(points, np.float32)
    u = (np.arange(w, dtype=np.float32) + 0.5) / w
    v = (np.arange(h, dtype=np.float32) + 0.5) / h
    lon = (u * 2.0 - 1.0) * np.float32(np.pi)
    lat = (0.5 - v) * np.float32(np.pi)
    p_lat = np.arcsin(np.clip(pts[:, 1], -1, 1))

    # a feature point can only own a pixel within ~3 mean spacings
    margin = 3.5 * np.sqrt(4.0 * np.pi / max(len(pts), 1))
    edge = np.empty((h, w), np.float32)
    f1 = np.empty((h, w), np.float32)
    cid = np.empty((h, w), np.int64)

    for r0 in range(0, h, band_rows):
        r1 = min(h, r0 + band_rows)
        lo, hi = lat[r1 - 1] - margin, lat[r0] + margin
        sel = np.nonzero((p_lat >= lo) & (p_lat <= hi))[0]
        if len(sel) < 2:
            sel = np.arange(len(pts))
        P = pts[sel]
        cl = np.cos(lat[r0:r1])[:, None]
        dx = (cl * np.sin(lon)[None, :]).ravel()
        dy = np.repeat(np.sin(lat[r0:r1])[:, None], w, 1).ravel()
        dz = (cl * np.cos(lon)[None, :]).ravel()
        D = np.stack([dx, dy, dz], 1).astype(np.float32)

        kk = min(k, len(P))
        dots = D @ P.T
        near = np.argpartition(-dots, kth=kk - 1, axis=1)[:, :kk]
        nd = np.take_along_axis(dots, near, 1)
        order = np.argsort(-nd, axis=1)
        near = np.take_along_axis(near, order, 1)

        # ca, cb: vectors from the sample point to the closest / a neighbouring seed
        ca = P[near[:, 0]] - D
        best = np.full(len(D), 4.0, np.float32)
        for j in range(1, kk):
            cb = P[near[:, j]] - D
            e = cb - ca
            n = np.linalg.norm(e, axis=1)
            good = n > 1e-7
            dd = np.full(len(D), 4.0, np.float32)
            dd[good] = np.einsum('ij,ij->i', 0.5 * (ca[good] + cb[good]),
                                 e[good] / n[good, None])
            best = np.minimum(best, dd)
        edge[r0:r1] = best.reshape(r1 - r0, w)
        f1[r0:r1] = np.linalg.norm(ca, axis=1).reshape(r1 - r0, w)
        # the owning seed's GLOBAL index, so callers can give every cell its own
        # value. Without it the only thing distinguishing one granule from the next
        # is the lane between them, and a continuous mesh of lanes reads as crazing.
        cid[r0:r1] = sel[near[:, 0]].reshape(r1 - r0, w)
    return edge, f1, cid


def fbm3_two_regime(x, y, z, knee_octave=3, gain_low=0.88, gain_high=0.55,
                    octaves=7, lac=2.0, seed=0):
    """fBm with a spectral break.

    Measured Cassini cloud-brightness power spectra go as n^-1.3 at large scales and
    n^-2.75 below ~2000 km, which corresponds to fBm gains of ~0.90 and ~0.55. Plain
    gain-0.5 fBm is far too red at large scales and is exactly why naive procedural
    gas giants come out soft and blobby.
    """
    total = np.zeros_like(np.asarray(x, np.float32))
    amp, freq, norm = 1.0, 1.0, 0.0
    for o in range(octaves):
        total += np.float32(amp) * perlin3(x * freq, y * freq, z * freq, seed + o * 1013)
        norm += amp
        amp *= gain_low if o < knee_octave else gain_high
        freq *= lac
    return total / np.float32(norm)

# ==========================================================================
# triangle-mesh kernel and preview rasteriser
# ==========================================================================

class Mesh:
    """Accumulates parts. Each part is smooth-shaded within itself; parts never
    share vertices, so every part boundary is automatically a hard crease."""

    def __init__(self):
        self.pos = []          # (n,3)
        self.col = []          # (n,3)
        self.glow = []         # (n,)
        self.idx = []          # (m,3)
        self.smooth = []       # per-part crease angle in degrees (None = flat)
        self.parts = []        # (vstart, vcount, fstart, fcount)

    def add(self, verts, faces, colour, glow=0.0, crease=40.0):
        verts = np.asarray(verts, np.float64).reshape(-1, 3)
        faces = np.asarray(faces, np.int64).reshape(-1, 3)
        v0 = sum(len(p) for p in self.pos)
        f0 = sum(len(f) for f in self.idx)
        self.pos.append(verts)
        c = np.asarray(colour, np.float64)
        self.col.append(np.broadcast_to(c, (len(verts), 3)).copy() if c.ndim == 1 else c.reshape(-1, 3))
        g = np.asarray(glow, np.float64)
        self.glow.append(np.broadcast_to(g, (len(verts),)).copy() if g.ndim == 0 else g.reshape(-1))
        self.idx.append(faces + v0)
        self.parts.append((v0, len(verts), f0, len(faces), crease))
        return v0

    def finish(self):
        P = np.concatenate(self.pos)
        C = np.concatenate(self.col)
        Gl = np.concatenate(self.glow)
        F = np.concatenate(self.idx)
        N = np.zeros_like(P)
        # angle-weighted face-normal averaging, restricted to each part and to pairs of
        # faces whose normals are within the part's crease angle. Cheap approximation:
        # average within the part, then for faces whose own normal deviates from the
        # smoothed one by more than the crease, split the vertex and keep the face normal.
        fn = _face_normals(P, F)
        for (v0, vc, f0, fc, crease) in self.parts:
            ff = F[f0:f0 + fc]
            nn = fn[f0:f0 + fc]
            acc = np.zeros((vc, 3))
            for k in range(3):
                np.add.at(acc, ff[:, k] - v0, nn * _corner_angle(P, ff, k)[:, None])
            ln = np.linalg.norm(acc, axis=1, keepdims=True)
            acc = np.where(ln > 1e-12, acc / np.maximum(ln, 1e-12), np.array([0.0, 0.0, 1.0]))
            N[v0:v0 + vc] = acc
            if crease is None:
                continue
            cosc = np.cos(np.radians(crease))
            # split any corner whose face normal disagrees with the averaged one
            extra_p, extra_c, extra_g, extra_n = [], [], [], []
            base = len(P) + sum(len(e) for e in extra_p)
            newv = {}
            for fi in range(fc):
                for k in range(3):
                    vi = ff[fi, k]
                    if float(np.dot(nn[fi], N[vi])) < cosc:
                        key = (vi, round(float(nn[fi][0]), 3), round(float(nn[fi][1]), 3), round(float(nn[fi][2]), 3))
                        if key not in newv:
                            newv[key] = base + len(extra_p)
                            extra_p.append(P[vi]); extra_c.append(C[vi]); extra_g.append(Gl[vi]); extra_n.append(nn[fi])
                        F[f0 + fi, k] = newv[key]
            if extra_p:
                P = np.concatenate([P, np.array(extra_p)])
                C = np.concatenate([C, np.array(extra_c)])
                Gl = np.concatenate([Gl, np.array(extra_g)])
                N = np.concatenate([N, np.array(extra_n)])
        return P, N, C, Gl, F


def _face_normals(P, F):
    a = P[F[:, 0]]; b = P[F[:, 1]]; c = P[F[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return np.where(ln > 1e-14, n / np.maximum(ln, 1e-14), np.array([0.0, 0.0, 1.0]))


def _corner_angle(P, F, k):
    i0 = F[:, k]; i1 = F[:, (k + 1) % 3]; i2 = F[:, (k + 2) % 3]
    u = P[i1] - P[i0]; v = P[i2] - P[i0]
    u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-14)
    v /= np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-14)
    return np.arccos(np.clip((u * v).sum(1), -1, 1))


# --------------------------------------------------------------------------- primitives
def lathe(profile, seg, close_start=False, close_end=False, twist=0.0):
    """Revolve a 2D profile [(z, r), ...] about the +Z axis into a tube.

    Rings with r==0 collapse to a single pole vertex, so a cone tip is one vertex,
    not `seg` coincident ones (duplicated tips break smooth-normal averaging and
    show as a black pixel at the nose -- which is exactly where the eye goes).
    """
    profile = [(float(z), float(r)) for z, r in profile]
    th = np.linspace(0, 2 * np.pi, seg, endpoint=False) + twist
    cs, sn = np.cos(th), np.sin(th)
    verts, ringidx = [], []
    for z, r in profile:
        if r <= 1e-9:
            ringidx.append(('pole', len(verts)))
            verts.append((0.0, 0.0, z))
        else:
            ringidx.append(('ring', len(verts)))
            for j in range(seg):
                verts.append((r * cs[j], r * sn[j], z))
    faces = []
    for i in range(len(profile) - 1):
        ka, sa = ringidx[i]
        kb, sb = ringidx[i + 1]
        if ka == 'pole' and kb == 'ring':
            for j in range(seg):
                faces.append((sa, sb + j, sb + (j + 1) % seg))
        elif ka == 'ring' and kb == 'pole':
            for j in range(seg):
                faces.append((sa + j, sb, sa + (j + 1) % seg))
        elif ka == 'ring' and kb == 'ring':
            for j in range(seg):
                j2 = (j + 1) % seg
                faces.append((sa + j, sb + j, sb + j2))
                faces.append((sa + j, sb + j2, sa + j2))
    if close_start and ringidx[0][0] == 'ring':
        s = ringidx[0][1]
        c = len(verts); verts.append((0.0, 0.0, profile[0][0]))
        for j in range(seg):
            faces.append((c, s + (j + 1) % seg, s + j))
    if close_end and ringidx[-1][0] == 'ring':
        s = ringidx[-1][1]
        c = len(verts); verts.append((0.0, 0.0, profile[-1][0]))
        for j in range(seg):
            faces.append((c, s + j, s + (j + 1) % seg))
    return np.array(verts, np.float64), np.array(faces, np.int64)


def plate(outline, thickness, orient="h", offset=(0.0, 0.0, 0.0)):
    """Extrude a closed 2D outline [(z, h), ...] into a thin slab.

    orient "h": h maps to +X, thickness along Y  (wings, canards)
    orient "v": h maps to +Y, thickness along X  (fins)
    orient "d": h maps to -Y, thickness along X  (ventral strakes)

    One helper with an explicit orientation, because hand-permuting the axis columns
    per part is how the first cut ended up with a horizontal tail fin and strakes
    pointing at the sky.
    """
    out = np.asarray(outline, np.float64)
    n = len(out)
    t = thickness * 0.5
    v = []
    for sgn in (+1, -1):
        for (z, h) in out:
            if orient == "h":
                p = [h, sgn * t, z]
            elif orient == "v":
                p = [sgn * t, h, z]
            else:
                p = [sgn * t, -h, z]
            v.append(p)
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, n + i, n + j))
        faces.append((i, n + j, j))
    for i in range(1, n - 1):
        faces.append((0, i, i + 1))
        faces.append((n, n + i + 1, n + i))
    v = np.array(v, np.float64) + np.asarray(offset, np.float64)
    return v, np.array(faces, np.int64)


def transform(v, scale=(1, 1, 1), rot=None, translate=(0, 0, 0), mirror_x=False):
    v = np.asarray(v, np.float64).copy()
    v *= np.asarray(scale, np.float64)
    if rot is not None:
        for axis, ang in rot:
            c, s = np.cos(ang), np.sin(ang)
            a, b = [(1, 2), (2, 0), (0, 1)][axis]
            va, vb = v[:, a].copy(), v[:, b].copy()
            v[:, a] = c * va - s * vb
            v[:, b] = s * va + c * vb
    if mirror_x:
        v[:, 0] *= -1
    v += np.asarray(translate, np.float64)
    return v


def flip(faces):
    f = np.asarray(faces).copy()
    f[:, [1, 2]] = f[:, [2, 1]]
    return f


# --------------------------------------------------------------------------- preview
def render_preview(P, N, C, Gl, F, size=420, yaw=0.6, pitch=0.35, uglow=0.55,
                   tint=(0.35, 0.84, 1.0), bg=(0.02, 0.025, 0.04), zoom=1.0):
    """Z-buffered software raster that reproduces the dashboard's rocket shader exactly:
        sh = 0.22 + 0.78*max(dot(N_view, normalize(-0.45,0.55,0.7)), 0)
        g  = min(glow*uGlow, 1.4)
        c  = col * mix(sh*0.9, 1.0, clamp(g,0,1)) * (1+g) * mix(1, tint, clamp(glow,0,1)*0.5)
    Judging the mesh in any other lighting model would be judging the wrong thing.
    """
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    M = Rx @ Ry
    V = P @ M.T
    NV = N @ M.T
    ext = np.abs(V).max() * 1.15 / max(zoom, 1e-6)
    sx = (V[:, 0] / ext * 0.5 + 0.5) * (size - 1)
    sy_ = (0.5 - V[:, 1] / ext * 0.5) * (size - 1)
    depth = V[:, 2]

    L = np.array([-0.45, 0.55, 0.7]); L /= np.linalg.norm(L)
    sh = 0.22 + 0.78 * np.maximum(NV @ L, 0.0)
    g = np.minimum(Gl * uglow, 1.4)
    gc = np.clip(g, 0, 1)
    tn = np.asarray(tint)
    tmix = 1.0 + (tn[None, :] - 1.0) * (np.clip(Gl, 0, 1) * 0.5)[:, None]
    vcol = C * (sh * 0.9 * (1 - gc) + gc)[:, None] * (1 + g)[:, None] * tmix

    img = np.zeros((size, size, 3)) + np.asarray(bg)
    zb = np.full((size, size), -1e18)
    a = np.stack([sx, sy_, depth], 1)
    for f in F:
        p0, p1, p2 = a[f[0]], a[f[1]], a[f[2]]
        area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])
        if area >= -1e-9:               # backface (screen y is down, so CCW -> negative)
            continue
        x0 = max(0, int(np.floor(min(p0[0], p1[0], p2[0])))); x1 = min(size - 1, int(np.ceil(max(p0[0], p1[0], p2[0]))))
        y0 = max(0, int(np.floor(min(p0[1], p1[1], p2[1])))); y1 = min(size - 1, int(np.ceil(max(p0[1], p1[1], p2[1]))))
        if x1 < x0 or y1 < y0:
            continue
        yy, xx = np.mgrid[y0:y1 + 1, x0:x1 + 1]
        xx = xx + 0.5; yy = yy + 0.5
        w0 = ((p1[0] - p0[0]) * (yy - p0[1]) - (xx - p0[0]) * (p1[1] - p0[1])) / area
        w1 = ((p2[0] - p1[0]) * (yy - p1[1]) - (xx - p1[0]) * (p2[1] - p1[1])) / area
        w2 = 1.0 - w0 - w1
        m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not m.any():
            continue
        # barycentrics: w1 belongs to v0, w2 to v1, w0 to v2 with the edge ordering above
        b0, b1, b2 = w1[m], w2[m], w0[m]
        z = b0 * p0[2] + b1 * p1[2] + b2 * p2[2]
        ys = yy[m].astype(int); xs = xx[m].astype(int)
        keep = z > zb[ys, xs]
        if not keep.any():
            continue
        ys, xs, b0, b1, b2, z = ys[keep], xs[keep], b0[keep], b1[keep], b2[keep], z[keep]
        col = b0[:, None] * vcol[f[0]] + b1[:, None] * vcol[f[1]] + b2[:, None] * vcol[f[2]]
        zb[ys, xs] = z
        img[ys, xs] = col
    return np.clip(img, 0, 1)


def orient_outward(v, f):
    """Flip winding if the closed part's signed volume is negative.

    Cheaper than reasoning about lathe direction every time a profile is reordered,
    and it catches the one bug that is invisible in a normal viewer but fatal here:
    the runtime material is FrontSide, so an inverted part just disappears.
    """
    v = np.asarray(v, np.float64); f = np.asarray(f, np.int64)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    vol = np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6.0
    return (v, flip(f)) if vol < 0 else (v, f)


def hull_strip(profile, theta_c, half_w, dr=1.07, nseg=5, zrange=None):
    """A thin slab that FOLLOWS a lathe's surface: a strip of hull trim.

    Built from the same profile so it curves with the body. A flat plate tangent to the
    hull instead reads as a sticker glued on -- which is what the first cut looked like.
    Returns a closed slab (outer face at r*dr, inner face at r*1.001).
    """
    prof = [(z, r) for (z, r) in profile if r > 1e-6 and
            (zrange is None or zrange[0] <= z <= zrange[1])]
    if len(prof) < 2:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64)
    th = np.linspace(theta_c - half_w, theta_c + half_w, nseg)
    v = []
    for mult in (dr, 1.001):
        for (z, r) in prof:
            for t in th:
                v.append((r * mult * np.cos(t), r * mult * np.sin(t), z))
    nz, nt = len(prof), nseg
    lay = nz * nt
    f = []

    def quad(a, b, c, d):
        f.append((a, b, c)); f.append((a, c, d))

    for i in range(nz - 1):
        for j in range(nt - 1):
            a = i * nt + j
            quad(a, a + nt, a + nt + 1, a + 1)                    # outer
            quad(lay + a, lay + a + 1, lay + a + nt + 1, lay + a + nt)   # inner
    for i in range(nz - 1):                                        # side walls
        a = i * nt
        quad(a, a + nt, lay + a + nt, lay + a)
        b = i * nt + nt - 1
        quad(b, lay + b, lay + b + nt, b + nt)
    for j in range(nt - 1):                                        # end caps
        a = j
        quad(a, a + 1, lay + a + 1, lay + a)
        b = (nz - 1) * nt + j
        quad(b, lay + b, lay + b + 1, b + 1)
    return np.array(v, np.float64), np.array(f, np.int64)

# ==========================================================================
# spiral galaxy discs
# ==========================================================================

def sersic_bn(n):
    return 1.9992 * n - 0.3271


def _disc_profile(r, h, r_break, h_out):
    inner = np.exp(-r / h)
    outer = np.exp(-r_break / h) * np.exp(-(r - r_break) / h_out)
    return np.where(r < r_break, inner, outer)


def _arm_phase(x, y, r, th, m, pitch_deg, seed, warp=1.0, phase=0.0,
               shear=0.0, shear_pa=0.0, r25=0.76):
    """psi; frac(psi) is the signed across-arm coordinate, round(psi) names the arm.

    `phase` rigidly rotates the pattern, which is how the arms get locked to the ends
    of the bar. `shear` is a tidal term: an m=1 azimuthal distortion growing as r^2,
    the leading-order effect of a companion on a disc. It winds one arm tighter and
    unwinds the other, because sin(th - pa) has opposite sign at th and th + pi -- so
    the two arms stop being related by a 180 deg rotation, which is the single most
    obvious giveaway in a procedural spiral and the reason real galaxies never look
    like one.
    """
    tan_i = np.tan(np.radians(pitch_deg))
    if shear:
        th = th + shear * np.clip(r / r25, 0, 1.5) ** 2 * np.sin(th - shear_pa)
    psi = (m * th) / TAU + np.log(np.maximum(r, 1e-4)) / (TAU * tan_i) + np.float32(phase)
    if warp > 0.0:
        amp = warp * (0.03 + 0.15 * np.clip(r / 0.8, 0, 1) ** 1.3)
        q = G.fbm3(x * 2.2, y * 2.2, np.float32(0.3), 4, seed=seed + 5)
        w = G.fbm3(x * 4.5 + 2.0 * q, y * 4.5 + 2.0 * q, np.float32(1.7), 4, seed=seed + 91)
        psi = psi + amp * (0.65 * q + 0.35 * w)
    return psi


def _stripe(psi, sigma):
    s = psi - np.round(psi)
    return np.exp(-0.5 * (s / sigma) ** 2)


def _teff(bv):
    """Ballesteros B-V -> effective temperature."""
    return 4600.0 * (1.0 / (0.92 * bv + 1.70) + 1.0 / (0.92 * bv + 0.62))


PALETTES = {
    # (bulge / old-population colour, arm / young-population colour)
    "cyan": ((1.00, 0.66, 0.30), (0.34, 0.82, 1.00)),
    "amber": ((1.00, 0.44, 0.13), (1.00, 0.86, 0.50)),
    "violet": ((1.00, 0.52, 0.58), (0.56, 0.44, 1.00)),
}


def build_disc(size, seed, pitch=15.0, arms=2, palette="cyan", floor=0.022,
               lopsided=0.13, hii_n=1100, star_n=22000, stretch=0.55, gain=3.6,
               bar=0.9, bar_pa=0.62, bar_len=0.33, bar_q=0.30, ring=0.0,
               tidal=0.26, tidal_pa=2.1, arm_mix=(1.0, 0.72), arm_end=(1.00, 0.80),
               n_gc=160, envelope=0.075):
    rng = np.random.default_rng(seed)
    ax = (np.arange(size, dtype=np.float32) + 0.5) / size * 2.0 - 1.0
    X, Y = np.meshgrid(ax, ax)
    R = np.hypot(X, Y).astype(np.float32)
    TH = np.arctan2(Y, X).astype(np.float32)

    R25 = 0.76
    h = R25 / 3.4
    r_break = 2.5 * h
    h_out = h / 2.0
    re = 0.17 * h
    bn = sersic_bn(2.0)

    bulge = np.clip(np.exp(-bn * ((np.maximum(R, 1e-4) / re) ** 0.5 - 1.0)), 0, 30.0)
    disc = _disc_profile(R, h, r_break, h_out)
    # The disc is allowed to run a little further out than it used to (0.56-0.855
    # before). The old taper put the last of the light at 0.72R and the plate simply
    # STOPPED there, which is what made the edge read as cotton wool; carrying the real
    # double-exponential disc -- arms, flocculence, resolved stars and all -- out to
    # where the alpha window takes over is what an outer envelope actually looks like.
    # An axisymmetric halo added on top was tried instead and rejected: any profile
    # faint enough not to lift the interarm floor inside the arms is invisible outside
    # them, and the ring-shaped compromise read as a soap bubble around the galaxy.
    taper = 1.0 - G.smoothstep(0.600, 0.875, R)

    # ------------------------------------------------------------ the bar
    # About two thirds of nearby spirals are barred, and the bar is the first thing
    # the eye uses to tell a real spiral from a procedural pinwheel. Three facts do
    # all the work here:
    #  * bar isophotes are BOXY, not elliptical: the generalised-ellipse exponent is
    #    measured at c ~ 2.5-3.5 for strong bars, against 2.0 for an ellipse.
    #  * the light profile along the major axis is FLAT-topped with a sharp end
    #    (an "SB" / early-type bar), not a gaussian -- a gaussian reads as a smear.
    #  * the two main arms spring FROM THE BAR ENDS, so the spiral pattern has to be
    #    phase-locked to the bar rather than floating free, and the region inside the
    #    bar radius is nearly empty of spiral structure.
    a_bar = bar_len * R25
    cpa, spa = np.float32(np.cos(bar_pa)), np.float32(np.sin(bar_pa))
    xb = X * cpa + Y * spa
    yb = -X * spa + Y * cpa
    mb = (np.abs(xb / a_bar) ** 2.8 + np.abs(yb / (bar_q * a_bar)) ** 2.8) ** (1.0 / 2.8)
    barl = np.clip(1.0 - mb ** 2.2, 0.0, 1.0) ** 0.95
    barl = barl * (0.55 + 0.45 * (0.5 + 0.5 * G.fbm3(X * 9.0, Y * 9.0, np.float32(2.9),
                                                     4, seed=seed + 1901)))
    barl = barl * np.float32(bar)

    # ------------------------------------------------------------ arm field
    # phase chosen so psi is an integer at (a_bar, bar_pa): the arm ridge starts at the
    # bar end. With m = 2 the other end is at psi + 1, also an integer, so both arms
    # spring from the bar for free.
    tan_i = np.tan(np.radians(pitch))
    phase0 = -((arms * bar_pa) / TAU + np.log(a_bar) / (TAU * tan_i))
    psi = _arm_phase(X, Y, R, TH, arms, pitch, seed, phase=phase0,
                     shear=tidal, shear_pa=tidal_pa, r25=R25)
    rr = np.clip(R / R25, 0, 1)
    sig_arm = 0.150 - 0.086 * rr                      # 60 deg azimuthal inner -> 26 deg outer

    # round(psi) names the arm, so each arm can carry its own amplitude and its own
    # truncation radius. Without this the m-fold pattern is exactly m-fold symmetric,
    # and a two-armed one reads as a logo. The boundary between the two labels sits at
    # the interarm minimum, where the stripe is ~0, so the switch is invisible.
    kid = np.mod(np.rint(psi), arms).astype(np.int32)
    amp_k = np.asarray(arm_mix, np.float32)[np.minimum(kid, len(arm_mix) - 1)]
    end_k = np.asarray(arm_end, np.float32)[np.minimum(kid, len(arm_end) - 1)]
    ridge = _stripe(psi, sig_arm) * amp_k * (1.0 - G.smoothstep(end_k * 0.74, end_k, rr))

    psi3 = _arm_phase(X, Y, R, TH, 3, pitch * 1.35, seed + 4400, phase=phase0 * 0.5)
    ridge = ridge + 0.20 * _stripe(psi3, sig_arm * 1.25)

    psi_s = _arm_phase(X, Y, R, TH, 14, 62.0, seed + 777, warp=0.4)
    spur = _stripe(psi_s, 0.20) * np.clip((psi - np.round(psi)) * -6.0, 0, 1)
    ridge = ridge * (1.0 + 0.50 * spur * rr)

    # the interbar region: inside the bar the gas is on x1 orbits, not in arms
    bar_gate = 0.22 + 0.78 * G.smoothstep(0.70 * a_bar, 1.18 * a_bar, R)
    ridge = ridge * (bar_gate if bar > 0 else 1.0)

    # Inner ring at the bar end: an SB(r) family member rather than SB(s). Very common
    # and strongly recognisable, so it is a per-disc switch and not all three use it.
    # It has to stay WEAK. At 0.40 it closed into a bright oval that merged with the
    # already-broad arms at this pitch, and the plate baked out as a doughnut with a
    # hole -- the two-armed structure the ring was supposed to decorate disappeared
    # entirely. At 0.18 it reads as a ring and the arms still read as arms.
    if ring > 0.0:
        ridge = ridge + ring * np.exp(-((R - 1.13 * a_bar) / (0.115 * a_bar)) ** 2) * \
            (0.65 + 0.35 * np.cos(2.0 * (TH - bar_pa)))

    ridge = ridge * (1.0 + lopsided * np.cos(TH - 0.9 + 1.4 * R))
    # Clumping must live at GRAIN scale. At freq 7 the blobs are a third of the disc
    # across and they delete whole arm sections, which reads as an irregular galaxy.
    lump = 0.5 + 0.5 * G.fbm3(X * 14.0, Y * 14.0, np.float32(4.1), 5, seed=seed + 31)
    ridge = ridge * (0.66 + 0.62 * lump)
    # Flocculence, applied only at large radius: real discs go from grand-design
    # inner arms to a broken, patchy outer disc. Applied globally (as a first cut
    # did) it deletes whole inner arm sections and the galaxy reads as irregular.
    floc = 0.5 + 0.5 * G.fbm3(X * 4.4, Y * 4.4, np.float32(7.7), 4, seed=seed + 1223)
    ridge = ridge * (1.0 - 0.60 * rr ** 1.6 * (1.0 - floc))

    # No global max-normalisation: dividing by the image-wide maximum (owned by the
    # bright inner arms) collapses the whole outer disc onto the interarm floor and
    # produces a uniform grey pancake.
    arm = np.clip(ridge / 1.05, 0.0, 1.0) ** 1.15
    # The interarm FLOOR has to fall with radius. Held constant it is what produces
    # the featureless outer haze (teal in the old cyan plate, brown in the amber one):
    # out there the smooth disc is all that is left, the stretch lifts it back to a
    # visible level, and the result is a flat wash with arms somewhere inside it. Real
    # outer discs are mostly empty between the arms.
    armlight = floor * (1.0 - 0.60 * rr ** 1.8) + (1.0 - floor) * arm

    # ------------------------------------------------------------ smooth light
    # Grain-scale patchiness in the SMOOTH light too, and only outward: the arm field
    # was already broken up this way but the underlying disc was not, so the outer disc
    # kept a perfectly smooth substrate under a patchy arm pattern.
    grain = 0.5 + 0.5 * G.fbm3(X * 19.0, Y * 19.0, np.float32(8.3), 4, seed=seed + 4409)
    patchy = 1.0 - 0.42 * rr ** 2.0 * (1.0 - grain)

    ref = 0.22 * bulge + 0.78 * disc * taper           # azimuthally smooth reference
    smooth = (0.22 * bulge + 0.78 * disc * taper * armlight * patchy +
              0.32 * barl * (0.30 + 0.70 * np.exp(-(R / (1.05 * a_bar)) ** 2)))

    # ------------------------------------------------------------ colour
    # The smooth disc's radial colour gradient is deliberately WEAKER than it was.
    # Pushed hard it paints the whole outer disc one saturated accent hue, which is
    # the poster look the docstring warns about arriving by the back door -- the blue
    # is supposed to come from the resolved young population and the HII knots, and
    # now that those actually survive the downscale they can carry it.
    bv = 0.92 - 0.50 * rr - 0.16 * arm
    t_lo, t_hi = _teff(0.92), _teff(0.28)
    u = np.clip((_teff(bv) - t_lo) / (t_hi - t_lo), 0, 1) ** 0.8
    c_warm, c_cool = (np.asarray(c, np.float32) for c in PALETTES[palette])
    rgbmap = c_warm[None, None, :] + (c_cool - c_warm)[None, None, :] * u[..., None]
    img = smooth[..., None] * rgbmap

    # ------------------------------------------------------------ dust lanes
    lane_off = 0.110 - 0.050 * rr
    sig_dust = sig_arm * 0.30
    lane = _stripe(psi + lane_off, sig_dust)
    lane3 = _stripe(psi3 + lane_off * 1.1, sig_dust * 1.25)
    clump = 0.40 + 0.85 * np.clip(G.ridged3(X * 4.6, Y * 4.6, np.float32(2.3), 5,
                                            seed=seed + 613), 0, 1)
    av = (4.6 * lane ** 1.6 + 1.2 * lane3 ** 1.6) * clump
    av = av + 0.22 * np.clip(G.fbm3(X * 3.2, Y * 3.2, np.float32(9.0), 5, seed=seed + 97), 0, 1)
    if bar > 0.0:
        # The bar's own two dust lanes, on the LEADING edge of each half and meeting
        # at the nucleus in a shallow S. They are the shock where gas on x1 orbits
        # piles up before falling inward, they are nearly straight, and they are the
        # second thing (after the boxy ends) that identifies a bar at a glance.
        t = np.clip(xb / a_bar, -1.0, 1.0)
        yc = -0.52 * bar_q * a_bar * np.tanh(3.2 * t) * np.sqrt(np.clip(1.0 - t * t, 0, 1))
        lane_w = 0.340 * bar_q * a_bar
        blane = np.exp(-0.5 * ((yb - yc) / lane_w) ** 2) * (1.0 - G.smoothstep(0.52, 0.92, np.abs(t)))
        # clumpy along their length: a lane of constant opacity reads as an inked line
        blane = blane * (0.30 + 1.05 * np.clip(G.fbm3(X * 13.0, Y * 13.0, np.float32(3.7),
                                                      4, seed=seed + 1033) + 0.5, 0, 1))
        av = av + 0.85 * bar * blane * (0.70 + 0.50 * clump)
    av = av * np.clip(_disc_profile(R, h * 1.5, r_break * 1.15, h_out) /
                      _disc_profile(np.float32(0.02), h * 1.5, r_break * 1.15, h_out), 0, 1)
    av = np.clip(av, 0, 4.2)
    img *= np.power(10.0, -0.4 * av[..., None] * EXT_RGB[None, None, :])
    # NB: `ref` deliberately does NOT carry the extinction. Feeding av into the stretch
    # reference divides the lanes back up to full brightness while keeping their
    # reddening, which turns every dust lane into a glowing gold band -- the single
    # worst-looking bug in this file's history.

    # ------------------------------------------------------------ stretch + tone
    # Divide out a fractional power of the smooth radial profile, THEN tone map. This
    # is the astrophotographic stretch; it equalises the radial dynamic range without
    # touching the azimuthal (arm vs interarm) contrast at any given radius.
    img = img / np.maximum(ref, 1e-4)[..., None] ** stretch
    img = G.tonemap(img, gain)

    def extinct(pts, frac):
        """Per-source transmission sampled from the same av map.

        Splatting stars on top of the finished plate with no extinction is what
        turned the dark lanes into gold beading: the star field does not know about
        the dust, so it fills the lane back in. Most stars sit behind most of the
        dust, so they must be attenuated by the same curve."""
        yi = np.clip(pts[:, 0].astype(int), 0, size - 1)
        xi = np.clip(pts[:, 1].astype(int), 0, size - 1)
        a = av[yi, xi][:, None] * frac
        return np.power(10.0, -0.4 * a * EXT_RGB[None, :]).astype(np.float32)

    # ------------------------------------------------------------ HII knots
    # Three corrections to where these go, all of them visible at full size:
    #  * They are CLUSTERED along the arm, not strung at uniform density. The observed
    #    two-point correlation of HII regions along an arm is strong out to ~500 pc,
    #    so real arms are beads in groups with long dark gaps between the groups; a
    #    uniform string of beads is the giveaway the previous cut had.
    #  * The weighting runs with the star-formation rate per unit area, which peaks
    #    around 0.3-0.5 R25 and falls inward -- and inside a bar the gas is already
    #    gone, so the interbar region should be nearly empty.
    #  * The BAR ENDS are hotspots: the bar dumps gas where it meets the arms, which
    #    is why barred spirals have a bright knot at each end of the bar.
    group = 0.5 + 0.5 * G.fbm3(X * 11.0, Y * 11.0, np.float32(6.7), 4, seed=seed + 3301)
    group = np.clip(group * 1.9 - 0.72, 0, 1) ** 1.2
    sfr = np.exp(-((rr - 0.42) / 0.40) ** 2)
    hii_field = (_stripe(psi - 0.050, sig_arm * 0.55) * disc * taper * sfr *
                 (0.22 + 1.6 * group) * (bar_gate if bar > 0 else 1.0))
    if bar > 0.0:
        bend = np.exp(-(((np.abs(xb) - a_bar) / (0.30 * a_bar)) ** 2 +
                        (yb / (0.52 * bar_q * a_bar)) ** 2))
        hii_field = hii_field + 2.2 * bar * bend * disc
        # nuclear ring: gas the bar has driven all the way in, now forming stars
        hii_field = hii_field + 1.1 * bar * np.exp(-((R - 0.20 * a_bar) / (0.052 * a_bar)) ** 2)
    if ring > 0.0:
        hii_field = hii_field + 0.9 * ring * np.exp(
            -((R - 1.13 * a_bar) / (0.085 * a_bar)) ** 2) * (0.3 + 0.7 * group)
    pts = _sample_field(hii_field, hii_n, rng)
    if len(pts):
        py, px = pts[:, 0], pts[:, 1]
        d = np.minimum(0.0026 * size * (1.0 - rng.random(len(pts))) ** (-1.0 / 3.0),
                       0.024 * size)
        lum = np.minimum((1.0 - rng.random(len(pts))) ** -1.0, 40.0) * 0.055
        # HII regions are embedded IN the dust, so only partially extincted
        tr = extinct(pts, 0.55)
        G.splat_gauss(img, px, py, d * 0.40, d * 0.40, lum,
                      np.array([1.00, 0.24, 0.40], np.float32)[None, :] * tr)
        cr = np.maximum(d * 0.10, size / 1500.0)
        G.splat_gauss(img, px, py, cr, cr, lum * 1.6,
                      np.array([0.95, 0.97, 1.00], np.float32)[None, :] * tr)
        # The handful of giant complexes (30 Dor / NGC 604 analogues) that a steep
        # luminosity function guarantees. Their haloes, not their cores, are what make
        # an arm look beaded at a distance, so each gets a wide faint skirt.
        top = np.argsort(-lum)[:max(3, len(pts) // 90)]
        G.splat_gauss(img, px[top], py[top], d[top] * 1.9, d[top] * 1.9, lum[top] * 0.22,
                      np.array([1.00, 0.34, 0.46], np.float32)[None, :] * tr[top])

    # ------------------------------------------------------------ resolved stars
    # TWO populations sampled from DIFFERENT fields. Drawing both from the arm field
    # strung the old yellow stars into gold beads along the arms, which is exactly
    # backwards: only the young population is arm-confined, the old disc+bulge
    # population is azimuthally smooth.
    # The plates ship at 1024 after a 2x box downscale, so a star splatted at 1.2 px
    # here is 0.6 px there: below the sampling limit, where a "resolved star field"
    # stops being resolved and averages into a smooth veil. That veil -- a broad,
    # structureless teal haze over the whole outer disc -- was the weakest part of the
    # previous plate, and it was the exact failure the docstring warns about, arriving
    # by a different route. Fewer, wider, brighter stars: ~1.9 px here, ~1 px shipped,
    # so individual stars survive the downscale and the outer disc reads as resolved.
    rad = max(0.80, size / 1080.0)
    # Weighted OUTWARD by (1 + 2.2 rr^2). Sampling the arm light alone puts almost
    # every young star in the bright inner arms, where they are lost against an
    # already-bright substrate; the outer disc, where a resolved star is the only
    # thing there is, got almost none. Before this the plate's apparent radius
    # visibly shrank against the previous bake -- the old outer teal veil was gone
    # and nothing had replaced it. Real discs are the other way round anyway: the
    # young population is the one that extends furthest.
    young = _sample_field(disc * taper * arm ** 1.8 * (1.0 + 2.2 * rr ** 2),
                          int(star_n * 0.72), rng)
    if len(young):
        c = np.minimum(c_cool * 0.70 + 0.40, 1.0)[None, :] * extinct(young, 0.85)
        c = c * (0.85 + 0.30 * rng.random((len(young), 1)))
        amp = (1.0 - rng.random(len(young))) ** 3.0 * 0.72
        G.splat_gauss(img, young[:, 1], young[:, 0],
                      np.full(len(young), rad), np.full(len(young), rad), amp, c)
    old = _sample_field(0.55 * (bulge / bulge.max()) ** 0.75 + disc * taper +
                        0.9 * barl, int(star_n * 0.28), rng)
    if len(old):
        c = (c_warm * 0.26 + 0.66)[None, :] * extinct(old, 0.85)
        c = c * (0.85 + 0.30 * rng.random((len(old), 1)))
        amp = (1.0 - rng.random(len(old))) ** 3.4 * 0.36
        G.splat_gauss(img, old[:, 1], old[:, 0],
                      np.full(len(old), rad), np.full(len(old), rad), amp, c)

    # ------------------------------------------------------------ globular clusters
    # The halo is not empty, and clusters are the only thing in it bright enough to
    # draw. They matter here out of proportion to their light: they are the one
    # population that lives OUTSIDE the disc, so they are what tells the eye the
    # galaxy has a third dimension instead of being a decal.
    #   * projected number density n(R) ~ R (1 + (R/rc)^2)^-3/2, cored at rc ~ 0.1 R25,
    #     inverted analytically below rather than rejection-sampled.
    #   * the globular cluster luminosity function is gaussian in MAGNITUDE (peak
    #     M_V = -7.4, sigma 1.2), i.e. log-normal in flux -- so a handful are much
    #     brighter than the rest, which is what stops them reading as a dot screen.
    #   * slightly extended (they are ~10 pc objects, marginally resolved at this
    #     plate scale) and old/yellow, with a small blue metal-poor outer subpopulation.
    if n_gc > 0:
        rc, rmax = 0.10 * R25, 0.80
        smax = rmax / rc
        wmin = 1.0 / np.sqrt(1.0 + smax * smax)
        w = 1.0 - rng.random(n_gc) * (1.0 - wmin)
        gr = rc * np.sqrt(np.maximum(1.0 / (w * w) - 1.0, 0.0))
        gth = rng.random(n_gc) * TAU
        gx = (gr * np.cos(gth) * 0.5 + 0.5) * size
        gy = (gr * np.sin(gth) * 0.5 + 0.5) * size
        gm = rng.normal(-7.4, 1.2, n_gc)
        gf = np.clip(10.0 ** (-0.4 * (gm + 7.4)), 0.05, 9.0) * 0.30
        grad = np.full(n_gc, rad * 1.75) * (1.0 + 0.30 * rng.random(n_gc))
        metalpoor = rng.random(n_gc) < 0.45
        gc_col = np.where(metalpoor[:, None],
                          (c_cool * 0.16 + 0.80)[None, :], (c_warm * 0.30 + 0.70)[None, :])
        G.splat_gauss(img, gx, gy, grad, grad, gf, gc_col)
        G.splat_gauss(img, gx, gy, grad * 3.2, grad * 3.2, gf * 0.085, gc_col)

    # ------------------------------------------------------------ tidal plume
    # One-sided, so it reads as a drawn-out tail rather than as a halo. Added AFTER
    # the stretch and the tone curve: folding it into the pre-stretch light does not
    # work, because the stretch divides by ref^0.55 and out past the disc `ref` is
    # pinned to its 1e-4 floor, which multiplies anything living there by ~180. A 2%
    # pre-stretch halo came back as a solid pancake with alpha 1.0 all the way to the
    # window (measured: interarm median 0.004 -> 0.102). Added here the amplitude is
    # exactly what the number says.
    plume = (np.exp(-((R - 0.70) / 0.195) ** 2) * G.smoothstep(0.52, 0.66, R) *
             np.clip(np.cos(TH - tidal_pa), 0, 1) ** 2.0 *
             (0.35 + 0.65 * (0.5 + 0.5 * G.fbm3(X * 3.1, Y * 3.1, np.float32(5.3), 4,
                                                seed=seed + 2207))))
    halo_col = (c_warm * 0.22 + c_cool * 0.30 + 0.52)[None, None, :]
    img = img + (envelope * 2.6 * tidal * plume)[..., None] * halo_col

    # ------------------------------------------------------------ nucleus
    nuc = np.exp(-(R / 0.017) ** 1.35)
    img += nuc[..., None] * (c_warm * 0.35 + 0.65)[None, None, :] * 0.95

    return np.clip(img, 0.0, None), R


def _sample_field(field, n, rng):
    f = np.clip(field, 0, None).astype(np.float64).ravel()
    tot = f.sum()
    if tot <= 0 or n <= 0:
        return np.zeros((0, 2), np.float32)
    idx = rng.choice(f.size, size=n, p=f / tot)
    w = field.shape[1]
    return np.stack([(idx // w) + rng.random(n), (idx % w) + rng.random(n)], 1).astype(np.float32)


def finish_disc(img, R, alpha_knee=0.10, fade_in=0.80, fade_out=0.895):
    """Window and key the plate.

    The window is hard-required: the runtime draws live point-star arms over this
    billboard, so it must be gone by 0.9 R. RGB is zeroed wherever alpha is zero --
    with straight alpha and mipmapping, bright RGB under zero alpha bleeds out as a
    square halo the moment the texture is minified.
    """
    win = 1.0 - G.smoothstep(fade_in, fade_out, R)
    out = np.clip(img * win[..., None], 0, 1)
    lum = out @ LUMW
    a = np.clip(lum / alpha_knee, 0, 1) * win
    out[a <= 0.002] = 0.0
    return out, np.clip(a, 0, 1)

# ==========================================================================
# planets and the star
# ==========================================================================

def _rotz(x, y, z, ang):
    """Rotate direction vectors about the polar (y) axis by a per-pixel angle.

    Rotating the direction rather than shifting the uv is what keeps advected bands
    seamless: there is no longitude wrap to get wrong.
    """
    c, s = np.cos(ang), np.sin(ang)
    return x * c + z * s, y, -x * s + z * c


# ============================================================ gas / ice giants
# Jupiter's measured zonal jets (BAA / Rogers, average of Voyager, HST, Cassini,
# New Horizons), planetographic latitude in degrees vs u3 in m/s. A single sinusoid
# in latitude explains only ~26% of the variance in Jupiter's real zonal brightness
# profile: the jets are IRREGULARLY spaced (mean 6.8 deg, range 3.4-12.3) and the
# prograde ones are stronger and narrower than the retrograde ones. That asymmetry
# and irregularity is most of what stops procedural bands looking like wallpaper.
JET_TABLE = [
    (-66.9, 29.4), (-61.0, 25.3), (-52.7, 41.1), (-43.1, 42.7), (-36.3, 38.2),
    (-32.3, -16.4), (-26.5, 49.0), (-19.5, -58.6), (-7.2, 139.7), (-0.4, 75.9),
    (7.2, 108.7), (17.0, -21.5), (23.7, 148.5), (31.1, -26.8), (35.1, 37.3),
    (39.3, -17.8), (42.7, 22.3), (47.4, 21.3), (55.8, 20.6), (63.8, 19.6),
    (68.4, 31.1),
]


# Fewer, much broader jets: an ice giant sits in the opposite Rhines-scale regime
# (one jet per hemisphere plus a retrograde equatorial one) rather than Jupiter's ~30.
# An intermediate rotator: a broad retrograde equatorial jet like an ice giant's,
# but with genuine alternation at mid latitudes, giving of order eight wide bands
# instead of Jupiter's thirty narrow ones.
#
# Worth stating plainly: a strictly Neptune-like profile was tried first and
# rejected. Neptune's jets are monotonic from equator to pole, so sign(lat)*du/dlat
# never changes sign, so there are no alternating zones and no belts -- the body
# renders as a featureless ball. That is astrophysically correct and visually
# useless at the 15 px this planet occupies, so the Rhines scale here is set
# between Jupiter's and Neptune's rather than at Neptune's.
ICE_TABLE = [(-86.0, 40.0), (-72.0, -70.0), (-56.0, 150.0), (-38.0, -95.0),
             (-20.0, 120.0), (-8.0, -210.0), (0.0, -250.0), (8.0, -210.0),
             (20.0, 115.0), (38.0, -90.0), (56.0, 145.0), (72.0, -65.0),
             (86.0, 38.0)]

_JET_CACHE = {}


def _jet_curve(table, scale):
    """Resample a jet table onto a fine grid and smooth it.

    np.interp straight off the table has a piecewise-CONSTANT derivative, so every
    knot becomes a discontinuity in du/dlat -- and since du/dlat is what selects
    belt vs zone, each knot showed up as a one-pixel-wide bright line. Smoothing
    once, here, fixes the profile and its derivative together.
    """
    key = (id(table), scale)
    if key in _JET_CACHE:
        return _JET_CACHE[key]
    xs = np.array([t[0] for t in table], np.float64)
    ys = np.array([t[1] for t in table], np.float64) * scale
    g = np.linspace(-90.0, 90.0, 1441)
    v = np.interp(g, xs, ys, left=ys[0] * 0.4, right=ys[-1] * 0.4)
    sd = 1.6 / (g[1] - g[0])
    kx = np.arange(-int(4 * sd), int(4 * sd) + 1)
    k = np.exp(-0.5 * (kx / sd) ** 2); k /= k.sum()
    v = np.convolve(np.pad(v, len(kx) // 2, mode="edge"), k, mode="valid")[:len(g)]
    out = (g.astype(np.float32), v.astype(np.float32))
    _JET_CACHE[key] = out
    return out


def zonal_jets(lat, table=None, squeeze=1.0, scale=1.0 / 148.5):
    tb = JET_TABLE if table is None else table
    g, v = _jet_curve(tuple(tb) if isinstance(tb, list) else tb, scale)
    return np.interp(np.degrees(lat) / squeeze, g, v).astype(np.float32)


def jet_shear(lat, **kw):
    """du/dlat. Its SIGN selects zone vs belt (anticyclonic shear = bright zone) and
    its MAGNITUDE sets how anisotropic the local eddies are (measured aspect ratios
    run 2:1 near the poles to 10:1 in the strongest shear, correlation r = +0.56)."""
    e = np.float32(0.035)
    return (zonal_jets(lat + e, **kw) - zonal_jets(lat - e, **kw)) / (2 * e)


def edge_meander(lat, lon, x, y, z, seed, rms_deg=3.0):
    """Displace the latitude used for the band lookup.

    Real band edges wander by 2-4 deg RMS with power at zonal wavenumbers 1-5 and
    14-21. Perfectly straight band edges are the single biggest 'procedural planet'
    tell there is, and this is the cheapest fix for it.
    """
    lo = np.zeros_like(lat)
    rng = np.random.default_rng(seed)
    for m in (1, 2, 3, 4, 5):
        ph = float(rng.uniform(0, 2 * np.pi))
        lo = lo + (1.0 / m) * np.sin(m * lon + ph + 0.8 * np.sin(lat * 3.0))
    hi = np.zeros_like(lat)
    for m in (14, 16, 18, 21):
        ph = float(rng.uniform(0, 2 * np.pi))
        hi = hi + (1.0 / (m * 0.32)) * np.sin(m * lon + ph + 1.7 * np.sin(lat * 5.0))
    d = 0.72 * lo + 0.28 * hi
    d = d / (np.abs(d).std() + 1e-6)
    return lat + np.radians(rms_deg) * d


def advected_field(x, y, z, u, seed, steps=(0.45, 1.15, 2.6), freqs=(2.6, 5.4, 11.0),
                   weights=(0.55, 0.30, 0.15), octaves=4):
    """Sample noise at several 'ages' along the zonal flow and sum.

    Each term is noise evaluated after transporting the sample point backwards along
    the jet for time t. Longer transport = more shear = longer, thinner filaments,
    so summing several t values gives the characteristic Jovian look: broad smooth
    zones carrying very long thin streaks that break up into curls at the shear
    boundaries. A single unadvected noise layer cannot produce that at any frequency.
    """
    out = None
    for t, f, w in zip(steps, freqs, weights, strict=False):
        ax, ay, az = _rotz(x, y, z, u * t)
        n = G.fbm3(ax * f, ay * f, az * f, octaves, seed=seed + int(t * 1000))
        out = w * n if out is None else out + w * n
    return out / sum(weights)


def add_vortex(lat, lon, v_lat, v_lon, a, b, spin, tilt=0.0):
    """Rotational domain warp inside an ellipse: an oval storm that DRAGS the
    surrounding filaments around itself.

    The wrap-around of the neighbouring bands is the whole point -- a storm painted
    as an isolated ellipse on top of the bands reads as a sticker. Computed as an
    angular displacement in the local tangent plane and then reapplied to lat/lon,
    which is exact and avoids juggling rotation axes on the sphere.

    Returns displaced (lat, lon), the elliptical radius, and the warp weight.
    """
    dlon = np.mod(lon - v_lon + np.pi, 2 * np.pi) - np.pi
    coslat = np.maximum(np.cos(lat), 0.15)
    dx = dlon * coslat
    dy = lat - v_lat
    ct, st = np.cos(tilt), np.sin(tilt)
    px = dx * ct + dy * st
    py = -dx * st + dy * ct
    d = np.sqrt((px / a) ** 2 + (py / b) ** 2)
    w = np.exp(-(d ** 2) * 1.3)
    ang = spin * w
    c, s_ = np.cos(ang), np.sin(ang)
    qx = px * c - py * s_
    qy = px * s_ + py * c
    ndx = (qx * ct - qy * st) - dx
    ndy = (qx * st + qy * ct) - dy
    return lat + ndy, lon + ndx / coslat, d, w


def polar_cyclones(X, Y, Z, hemi, n, colat, radius, seed, spin=1.0):
    """A ring of circumpolar cyclones plus one on the axis, Juno-style.

    Jupiter's poles are not blank: each carries a polygonal ring of cyclones (eight
    north, five south) around a central one, each a few thousand km across. It is the
    single most recognisable thing about a giant planet's pole and it is the obvious
    thing to put where the zonal bands have been blended out.

    Everything here is computed from 3D dot products against each cyclone's own axis,
    never from lat/lon, because lat/lon is exactly what degenerates at the pole: an
    `add_vortex`-style displacement in longitude goes singular there and smears the
    storms into a pinwheel. The azimuth around each cyclone comes from its own local
    frame, so the spiral arms stay round right over the axis.
    """
    rng = np.random.default_rng(seed)
    out = np.zeros_like(X)
    axis = np.array([0.0, float(hemi), 0.0], np.float32)
    centres = [axis]
    for i in range(n):
        a = 2 * np.pi * i / n + float(rng.uniform(0, 2 * np.pi)) * 0.0 + 0.21 * hemi
        a += float(rng.normal(0, 0.10))                      # the ring is a polygon, not a circle
        cc = float(colat) * (1.0 + float(rng.normal(0, 0.09)))
        centres.append(np.array([np.sin(cc) * np.cos(a), hemi * np.cos(cc),
                                 np.sin(cc) * np.sin(a)], np.float32))
    up = np.array([1.0, 0.0, 0.0], np.float32)
    for j, c in enumerate(centres):
        c = c / np.linalg.norm(c)
        e1 = np.cross(c, up)
        nrm = np.linalg.norm(e1)
        if nrm < 1e-3:
            e1 = np.cross(c, np.array([0.0, 0.0, 1.0], np.float32))
            nrm = np.linalg.norm(e1)
        e1 = e1 / nrm
        e2 = np.cross(c, e1)
        ca = np.clip(X * c[0] + Y * c[1] + Z * c[2], -1, 1)
        ang = np.arccos(ca)
        r = float(radius) * (0.78 + 0.5 * float(rng.random())) * (1.25 if j == 0 else 1.0)
        env = np.exp(-(ang / r) ** 2.2)
        phi = np.arctan2(X * e2[0] + Y * e2[1] + Z * e2[2],
                         X * e1[0] + Y * e1[1] + Z * e1[2])
        # two-armed spiral wound the cyclonic way for this hemisphere
        arm = 0.5 + 0.5 * np.cos(2.0 * phi + hemi * spin * 7.0 * np.log(np.maximum(ang, 1e-3) / r))
        eye = np.exp(-(ang / (r * 0.26)) ** 2)
        out = out + env * (0.40 + 0.60 * arm) * (1.0 - 0.55 * eye)
    return np.clip(out, 0.0, 1.6)


def latlon_to_dir(lat, lon):
    cl = np.cos(lat)
    return (cl * np.sin(lon)).astype(np.float32), np.sin(lat).astype(np.float32), \
           (cl * np.cos(lon)).astype(np.float32)


def bake_gas_giant(w, h, seed, kind="gas"):
    """Banded giant. kind: 'gas' (Jupiter-like) or 'ice' (fewer, broader jets)."""
    x, y, z, lat, lon = G.equirect_dirs(w, h)
    X = np.broadcast_to(x, (h, w)).astype(np.float32)
    Y = np.broadcast_to(y, (h, w)).astype(np.float32)
    Z = np.broadcast_to(z, (h, w)).astype(np.float32)
    LAT = np.broadcast_to(lat[:, None], (h, w)).astype(np.float32)
    LON = np.broadcast_to(lon[None, :], (h, w)).astype(np.float32)
    rng = np.random.default_rng(seed)
    ice = (kind == "ice")
    jt = ICE_TABLE if ice else JET_TABLE
    sq = 1.0
    jscale = (1.0 / 250.0) if ice else (1.0 / 148.5)

    # band edges meander before anything is looked up, so the colour stamp, the jet
    # profile and the detail all stay registered to the same wandering edge
    MLAT = edge_meander(LAT, LON, X, Y, Z, seed, rms_deg=2.2 if ice else 3.4)
    u = zonal_jets(MLAT, table=jt, squeeze=sq, scale=jscale)
    sh = jet_shear(MLAT, table=jt, squeeze=sq, scale=jscale)

    # zones are ANTICYCLONIC: sign(lat) * du/dlat > 0. Measured zone/belt brightness
    # ratio is only 1.23 and the redness difference 18/255 -- Jupiter is far less
    # saturated than it is usually painted (Oklab chroma median 0.017).
    anti = np.sign(MLAT) * sh
    zone = G.smoothstep(-1.5, 1.5, anti / (np.abs(sh).std() + 1e-6))

    det = advected_field(X, Y, Z, u, seed)
    # eddy anisotropy tracks |du/dy|: 10:1 in the strong-shear belts, isotropic at
    # the poles. Implemented as extra advection time where the shear is large.
    aniso = np.clip(np.abs(sh) / (np.abs(sh).max() + 1e-6), 0, 1) * np.cos(LAT) ** 2
    ax, ay, az = _rotz(X, Y, Z, u * (1.6 + 5.0 * aniso))
    det = 0.62 * det + 0.38 * G.fbm3_two_regime(ax * 7.5, ay * 7.5, az * 7.5, seed=seed + 808)

    # ---- vortices
    storms = []
    if not ice:
        # hero oval in the shear gap between a strong retrograde and a modest
        # prograde jet, at ~22S, aspect ~1.35 (the GRS is 1.1-1.5, not a circle)
        storms.append((np.radians(-22.0), 1.10, 0.30, 0.22, 2.4, 1.0, 1.0))
        for _ in range(6):
            storms.append((float(rng.uniform(-0.80, 0.80)),
                           float(rng.uniform(-np.pi, np.pi)),
                           float(rng.uniform(0.07, 0.14)),
                           float(rng.uniform(0.05, 0.10)),
                           float(rng.choice([-1.0, 1.0])) * float(rng.uniform(1.0, 2.0)),
                           0.0, 0.55))
    else:
        storms.append((0.98, 0.4, 0.34, 0.30, 1.6, 0.0, 0.9))
        storms.append((-0.44, 2.3, 0.26, 0.15, -2.0, 0.0, -0.75))   # a Great Dark Spot
        storms.append((0.30, -1.1, 0.14, 0.09, 1.5, 0.0, 0.8))

    core = np.zeros((h, w), np.float32)
    tintf = np.zeros((h, w), np.float32)
    for (vlat, vlon, va, vb, spin, tint, bright) in storms:
        wlat, wlon, d, wgt = add_vortex(LAT, LON, vlat, vlon, va, vb, spin)
        nx, ny, nz = latlon_to_dir(wlat, wlon)
        local = G.fbm3(nx * 10.0, ny * 10.0, nz * 10.0, 4, seed=seed + 313)
        # hollow vortex: the tangential speed peaks at the RIM and is ~0 in the core,
        # which is why the GRS reads as a ring of turbulence around a calm middle
        ring = np.exp(-((d - 0.88) / 0.30) ** 2)
        det = det * (1.0 - wgt) + (0.45 * local + 0.55 * ring) * wgt
        core += np.exp(-(d ** 3.4)) * bright
        tintf += np.exp(-(d ** 3.4)) * tint
    core = np.clip(core, 0, 1.2)

    if ice:
        # Discrete bright methane cloud streaks, advected hard along the jets and
        # thresholded so they are sparse. Without them an ice giant is a featureless
        # ball -- which is honest, but useless as a 15 px landmark on a dashboard.
        sx_, sy_, sz_ = _rotz(X, Y, Z, u * 4.2)
        streak = G.fbm3(sx_ * 3.4, sy_ * 14.0, sz_ * 3.4, 5, seed=seed + 5150)
        streak = np.clip(streak * 2.2 - 0.55, 0, 1) ** 1.3
        streak = streak * np.exp(-((np.abs(LAT) - 0.58) / 0.42) ** 2)
        core = np.clip(core + 1.5 * streak, 0, 1.8)

    # ---- luminance. Band edges are sharp: the real 10-90% belt->zone transition
    # spans only ~4.4 deg of latitude, so a tanh with a steep slope, not a sinusoid.
    # within-band longitudinal contrast is 5% of the local mean in quiet regions
    # and 10-12% in the active belts -- without it the bands read as painted stripes
    lum = 0.58 + 0.28 * zone + 0.105 * det * (0.5 + 1.1 * (1.0 - zone))
    lum = lum + 0.18 * core * (1.0 - 0.35 * zone)
    # Poleward of ~50 deg the measured eddy aspect ratio collapses to 1.2-1.3, so the
    # zonal structure is blended out. What replaces it used to be a single octave of
    # low-contrast mottle, which is why the poles read as a grey smudge -- and because
    # it was sampled at an INTEGER frequency it also sat on a Perlin lattice vertex at
    # the pole (see _LATTICE_OFF), giving the cap its octagonal edge. Now: a
    # domain-warped two-regime field (folded filaments, as Juno sees) plus the
    # circumpolar cyclone ring, and a tighter hood boundary so the cap has an EDGE.
    polar = G.smoothstep(0.86, 1.12, np.abs(LAT))
    pw = G.warp3(X * 2.7, Y * 2.7, Z * 2.7, amount=0.55, freq=1.3, seed=seed + 4243)
    mott = G.fbm3_two_regime(pw[0] * 3.3, pw[1] * 3.3, pw[2] * 3.3, seed=seed + 4242)
    mott = 0.62 * mott + 0.38 * G.ridged3(pw[0] * 6.1, pw[1] * 6.1, pw[2] * 6.1, 5,
                                          seed=seed + 4244)
    # Jupiter's real ring is eight cyclones of 3.8 deg diameter at colatitude 7 deg,
    # which at the 15-40 px these bodies occupy is nothing at all. Scaled up by ~2x in
    # both ring radius and storm size -- the same knowing exaggeration the granulation
    # and jet amplitudes already carry -- while keeping the count, the near-touching
    # spacing and the central storm, which is what the feature actually reads as.
    cyc = (polar_cyclones(X, Y, Z, +1.0, 8 if not ice else 5, 0.26, 0.052, seed + 70) +
           polar_cyclones(X, Y, Z, -1.0, 5 if not ice else 4, 0.24, 0.058, seed + 71))
    cap = (0.56 if not ice else 0.70) + 0.24 * mott + 0.34 * cyc - 0.10 * cyc ** 2
    lum = lum * (1.0 - polar) + cap * polar
    # the hood itself: a thin darker/brighter collar right at the boundary, which is
    # what actually makes the cap read as a cap rather than as a fade-out
    collar = np.exp(-((np.abs(LAT) - 0.99) / 0.085) ** 2)
    lum = lum * (1.0 - (0.13 if not ice else -0.08) * collar)
    lum = lum * (1.0 - 0.14 * np.abs(np.sin(LAT)) ** 3)          # polar hoods
    lum = np.clip(lum, 0.10, 1.0)

    # ---- chroma: belts carry the chromophores. Kept deliberately weak.
    # The chromophores are a mid-latitude phenomenon: measured polar hoods are grey to
    # bluish, so the warm tint is faded out under the same `polar` mask that removed
    # the bands. Leaving it on is what made the old cap look like dirty cream.
    warm = np.clip(1.0 - zone + 0.30 * det, 0, 1) * (1.0 - 0.80 * polar)
    hue = np.stack([1.0 + 0.11 * warm, np.ones_like(warm), 1.0 - 0.15 * warm], -1)
    hue = hue * (1.0 - polar[..., None] * np.array([0.045, 0.012, -0.030], np.float32))
    # hero storm reads terracotta (#A5744C), R:G:B ~ 1.00:0.70:0.46 -- not crimson
    hue = hue * (1.0 + tintf[..., None] * np.array([0.10, -0.16, -0.34], np.float32))
    return np.clip(G.polar_bandlimit(lum[..., None] * hue), 0, 1).astype(np.float32)


# ============================================================ aurora / terrestrial
def bake_aurora_world(w, h, seed):
    """A terrestrial body: continents, ice caps, and auroral ovals at the magnetic poles.

    Land/sea contrast is the strongest large-scale signal available, and large-scale
    contrast is all that survives at 9-15 px on screen. The aurora ovals are RINGS
    offset from the geographic poles, not caps -- that offset ring is what reads as an
    aurora rather than as a glowing polar blob.
    """
    x, y, z, lat, lon = G.equirect_dirs(w, h)
    X = np.broadcast_to(x, (h, w)).astype(np.float32)
    Y = np.broadcast_to(y, (h, w)).astype(np.float32)
    Z = np.broadcast_to(z, (h, w)).astype(np.float32)
    LAT = np.broadcast_to(lat[:, None], (h, w)).astype(np.float32)

    # Continents must be CONTINENT-sized: the first cut ran the base noise at
    # frequency 1.9 with a heavy warp and produced a leopard print, not landmasses.
    wx, wy, wz = G.warp3(X * 0.95, Y * 0.95, Z * 0.95, amount=0.42, freq=0.7, seed=seed)
    cont = G.fbm3(wx, wy, wz, 5, gain=0.44, seed=seed + 17)
    cont = cont + 0.22 * G.fbm3(X * 3.0, Y * 3.0, Z * 3.0, 4, seed=seed + 71) - 0.045
    land = G.smoothstep(0.00, 0.055, cont)

    # shelf water then deep ocean -- a single flat sea colour reads as plastic
    depth = np.clip((0.02 - cont) / 0.42, 0, 1)
    sea = 0.52 - 0.22 * depth
    detail = 0.5 + 0.5 * G.fbm3(X * 14.0, Y * 14.0, Z * 14.0, 5, seed=seed + 205)
    ground = 0.60 + 0.30 * detail

    ice = G.smoothstep(0.86, 0.99, np.abs(np.sin(LAT)) +
                       0.10 * G.fbm3(X * 6.0, Y * 6.0, Z * 6.0, 4, seed=seed + 9))
    lum = sea * (1 - land) + ground * land
    lum = lum * (1 - ice) + 0.97 * ice

    # banded cloud (zonal, like any rotating atmosphere), thin enough to read through
    cloud = np.clip(G.fbm3(X * 2.2 + 5.0, Y * 5.0, Z * 2.2, 6, seed=seed + 404) * 1.5 - 0.35,
                    0, 1) ** 1.3
    cloud = cloud * (0.35 + 0.65 * np.cos(2.6 * LAT) ** 2)
    lum = lum * (1 - 0.62 * cloud) + 0.97 * 0.62 * cloud

    # auroral ovals: rings at ~22 deg from each magnetic pole, tilted off the spin axis
    aur = np.zeros((h, w), np.float32)
    for pole in (+1, -1):
        px, py, pz = np.sin(0.30) * np.cos(1.1), pole * np.cos(0.30), np.sin(0.30) * np.sin(1.1)
        ca = np.clip(X * px + Y * py + Z * pz, -1, 1)
        ang = np.arccos(ca)
        ring = np.exp(-((ang - 0.38) / 0.085) ** 2)
        curt = 0.55 + 0.45 * G.fbm3(X * 11.0, Y * 11.0, Z * 11.0, 4, seed=seed + 88 + pole)
        aur += ring * curt
    aur = np.clip(aur, 0, 1)

    lum = np.clip(lum + 0.30 * aur, 0.12, 1.0)
    hue = np.stack([1.0 - 0.05 * land - 0.14 * aur,
                    np.ones_like(lum),
                    1.0 + 0.10 * (1.0 - land) - 0.10 * aur], -1)
    return np.clip(G.polar_bandlimit(lum[..., None] * hue), 0, 1).astype(np.float32)


# ============================================================ star
def bake_star(w, h, seed, n_gran=1100, n_super=60, n_spots=4):
    """Photosphere: granulation with narrow constant-width intergranular lanes, a
    supergranular MAGNETIC NETWORK (not a thermal cell pattern), and sunspot groups.

    Three corrections over the naive Voronoi approach, all of them measurable:

    1. Lanes come from Quilez's distance-to-the-bisector, not from F1 or F2-F1. F1
       alone gives the puffy 'golf ball' the previous map had; F2-F1 gives borders
       whose width wanders with the local seed spacing. Real intergranular lanes are
       200-300 km, i.e. 0.15-0.22 of the ~1360 km cell pitch, at CONSTANT width, and
       they cover about a third of the surface.
    2. Supergranulation is invisible in intensity -- its thermal contrast is 7.8e-4
       (about 1.1 K), some 200x weaker than granulation. What you actually see at
       that scale is the magnetic network riding on the cell BOUNDARIES, at ~2% (up
       to 7-10% as plage inside active regions). So no supergranule cells are painted;
       only their boundaries, and only as brightening.
    3. The umbra is not black, it is a cooler blackbody: at ~4400 K its per-channel
       ratio to the photosphere is roughly (0.29, 0.235, 0.165) -- blue suppressed
       about 2.2x more than red. That ratio is what makes a spot read as a warm ember
       rather than a drilled hole.

    Granulation RMS contrast in the real photosphere is 0.158 at 550 nm once the
    instrument PSF is deconvolved out; it is pushed a little above that here because
    the body is only ~140 px on screen and the detail otherwise averages away.
    """
    rng = np.random.default_rng(seed)
    x, y, z, lat, lon = G.equirect_dirs(w, h)
    X = np.broadcast_to(x, (h, w)).astype(np.float32)
    Y = np.broadcast_to(y, (h, w)).astype(np.float32)
    Z = np.broadcast_to(z, (h, w)).astype(np.float32)
    LAT = np.broadcast_to(lat[:, None], (h, w)).astype(np.float32)

    # ---- granulation, two populations (real granule sizes peak near 750 and 1500 km)
    cell = np.sqrt(4.0 * np.pi / n_gran)
    # Heavy jitter (0.42 of the cell pitch): an unjittered Fibonacci lattice leaves
    # visible concentric spiral arcs in the cell arrangement, which read as machining
    # marks. Real granulation has two size populations and no long-range order.
    pts = G.fibonacci_sphere(n_gran, rng, jitter=0.42 * cell)
    edge, _f1, cid = G.voronoi_edge_equirect(h, w, pts, k=10)
    lane = (1.0 - G.smoothstep(0.0, 0.17 * cell, edge)) ** 1.6

    n2 = n_gran * 4
    cell2 = np.sqrt(4.0 * np.pi / n2)
    pts2 = G.fibonacci_sphere(n2, rng, jitter=0.42 * cell2)
    edge2, _f1b, cid2 = G.voronoi_edge_equirect(h, w, pts2, k=9)
    lane2 = (1.0 - G.smoothstep(0.0, 0.18 * cell2, edge2)) ** 1.6

    # Lanes must BREAK. A continuous mesh of equal-strength lanes across the whole
    # sphere reads as crazing on pottery, which is what the first cut looked like;
    # modulating the lane depth with noise and giving each granule its own brightness
    # is what turns the mesh back into a field of separate convection cells.
    # `brk` breaks the lanes, and it has to do so at a scale SMALLER than a cell.
    # At frequency 26 its wavelength was ~2.2 cell pitches, so it made patches of
    # strong and weak lanes instead of gaps in individual lane segments, and the
    # network stayed topologically continuous -- which is the crazing.
    brk = 0.5 + 0.5 * G.fbm3(X * 62.0, Y * 62.0, Z * 62.0, 4, seed=seed + 991)
    # PER-GRANULE brightness, hashed off the Voronoi cell index. The previous
    # "cellbright" was a plain fBm field with no relation to the cells at all, so
    # every granule had the same brightness and the only thing separating one from
    # the next was the lane -- which is exactly why the map read as crazing on an
    # egg rather than as convection cells, despite the weighting having been chosen
    # to avoid that. Pure per-cell values at full strength were tried and read as
    # flat stained glass, so it is a blend: a third cell-keyed, a sixth from the
    # finer population, half smooth.
    z0 = np.zeros_like(cid)
    cb1 = G.hash01(cid, z0, z0, seed + 5501) * 2.0 - 1.0
    cb2 = G.hash01(cid2, np.zeros_like(cid2), np.zeros_like(cid2), seed + 5502) * 2.0 - 1.0
    cellbright = (0.34 * cb1 + 0.16 * cb2 +
                  0.52 * G.fbm3(X * 11.0, Y * 11.0, Z * 11.0, 3, seed=seed + 55))
    # Weighting matters more than the lane geometry here. At 140 px on screen the
    # granule pitch is ~4 px, so a strong lane mesh reads as crazing on an egg -- the
    # cell-to-cell BRIGHTNESS variation survives downsampling, the lane network does
    # not. So the lanes are deliberately underweighted relative to the real Sun and
    # the per-granule brightness is pushed well above it.
    mottle = G.fbm3(X * 3.2, Y * 3.2, Z * 3.2, 4, seed=seed + 1717)
    granule = (1.0 - 0.20 * lane * (0.10 + 1.30 * brk)
                   - 0.07 * lane2 * (0.10 + 1.30 * (1.0 - brk)))
    granule = granule + 0.62 * cellbright + 0.28 * mottle
    gran = (granule - granule.mean()) / (granule.std() + 1e-6)
    inten = 1.0 + 0.105 * gran

    # ---- supergranular magnetic network: boundaries only, brightening only
    sp = G.fibonacci_sphere(n_super, rng, jitter=0.18 * np.sqrt(4 * np.pi / n_super))
    se, _, _ = G.voronoi_edge_equirect(h, w, sp, k=8)
    cells = np.sqrt(4.0 * np.pi / n_super)
    network = 1.0 - G.smoothstep(0.0, 0.055 * cells, se)
    aL = np.abs(LAT)
    active = np.clip(np.exp(-((aL - 0.30) / 0.22) ** 2), 0, 1)
    plage = 0.5 + 0.5 * G.fbm3(X * 5.0, Y * 5.0, Z * 5.0, 4, seed=seed + 77)
    faculae = network * (0.25 + 0.75 * active * plage)
    inten = inten * (1.0 + 0.070 * faculae)

    # ---- sunspot groups. Butterfly diagram: latitudes run 28 deg early in a cycle
    # down to about 7 deg late, never above ~40 or below ~3.
    phase = float(rng.random())
    mean_lat = np.radians(7.0 + 21.0 * (1.0 - phase))
    umb = np.zeros((h, w), np.float32)
    pen = np.zeros((h, w), np.float32)
    for k in range(n_spots):
        hemi = 1.0 if k % 2 == 0 else -1.0
        slat = hemi * float(abs(rng.normal(mean_lat, np.radians(4.0))))
        slat = float(np.clip(abs(slat), np.radians(4.0), np.radians(38.0))) * hemi
        slon = float(rng.uniform(-np.pi, np.pi))
        # Joy's law group tilt: not used in the projection, but the draw MUST stay.
        # It advances the RNG stream, and every sunspot placed after it depends on
        # that state - deleting it as "unused" silently moved every spot on the star.
        _tilt = 0.4 * slat * (1.0 + float(rng.normal(0, 1.0)))
        # Joy's law: group tilt ~ 0.4 * latitude, with scatter as large as the mean
        cx = np.cos(slat) * np.sin(slon); cy = np.sin(slat); cz = np.cos(slat) * np.cos(slon)
        ang = np.arccos(np.clip(X * cx + Y * cy + Z * cz, -1, 1))
        r_spot = float(rng.uniform(0.11, 0.21))
        r_um = 0.45 * r_spot                       # A_total = 5 * A_umbra
        # radially warped granulation -> penumbral filaments. Stretching the SAME
        # cell field radially keeps the dark parts multiply connected, which is how
        # Solanki describes real penumbrae (topologically like intergranular lanes).
        phi = np.arctan2(Y - cy, X - cx)
        fil = 0.5 + 0.5 * np.cos(phi * 46.0 + ang * 55.0 + 3.0 * gran)
        p = (1.0 - G.smoothstep(r_um * 0.85, r_spot, ang)) * (0.70 + 0.30 * fil)
        uu = 1.0 - G.smoothstep(r_um * 0.55, r_um * 1.10, ang)
        pen = np.maximum(pen, p * (1.0 - uu))
        umb = np.maximum(umb, uu)
        # facular ring hugging the spot
        inten = inten + 0.09 * np.exp(-((ang - r_spot * 1.20) / (r_spot * 0.40)) ** 2) * plage

    base = np.clip(inten, 0.25, 1.9)
    photos = 0.82                                   # where the quiet photosphere sits

    rgb = np.repeat((base * photos)[..., None], 3, -1)
    # penumbra 0.768 I_QS, mildly warm; umbra ~0.235 and strongly warm
    PEN = np.array([0.82, 0.768, 0.700], np.float32)
    UMB = np.array([0.29, 0.235, 0.165], np.float32)
    rgb = rgb * (1.0 + pen[..., None] * (PEN - 1.0)[None, None, :])
    rgb = rgb * (1.0 + umb[..., None] * (UMB - 1.0)[None, None, :])
    # faint global warm/cool: hotter granule tops slightly bluer, lanes slightly warmer
    t = np.clip((base - 0.6) / 0.9, 0, 1)
    rgb = rgb * np.stack([1.0 + 0.05 * (1 - t), np.ones_like(t), 1.0 - 0.09 * (1 - t)], -1)
    return np.clip(G.polar_bandlimit(rgb), 0, 1).astype(np.float32)

# ==========================================================================
# the sky
# ==========================================================================

def _upsample(a, fy, fx):
    """Smooth box-and-linear upsample. Nebula and band fields are inherently smooth,
    so they are evaluated at half resolution and scaled up -- a 4x saving on the most
    expensive part of the bake with no visible difference."""
    if fy == 1 and fx == 1:
        return a
    out = np.repeat(np.repeat(a, fy, 0), fx, 1)
    # longitude wraps, latitude does NOT -- rolling on axis 0 stitches the north pole
    # onto the south pole and leaves a bright seam along both edge rows.
    out = (np.roll(out, 1, 1) * 0.25 + out * 0.5 + np.roll(out, -1, 1) * 0.25)
    up = np.concatenate([out[:1], out[:-1]], 0)
    dn = np.concatenate([out[1:], out[-1:]], 0)
    return up * 0.25 + out * 0.5 + dn * 0.25


# Milky Way scale heights, kpc. Everything about how the band looks follows from
# the dust layer being H_STAR / H_DUST = 2.4x thinner than the stellar one, so the
# ratio is derived from the two numbers here and used by both the transfer table and
# the band itself; it is not a constant written down twice.
H_STAR, H_DUST = 0.300, 0.125
_SLAB_P = H_DUST / H_STAR
_SLAB_T = np.concatenate([np.linspace(0.0, 4.0, 161), np.geomspace(4.2, 400.0, 180)])


def _slab_table():
    """e^-T * int_0^1 u^(p-1) e^(Tu) du, tabulated.

    The substitution u = t^(1/p) turns the integrable singularity at u = 0 into
    (1/p) * int_0^1 exp(T t^(1/p)) dt, which 64-node Gauss-Legendre nails exactly;
    doing it on u directly loses several digits near T = 0 where the answer matters
    most (it is the unobscured limit 1/p).
    """
    x, wq = np.polynomial.legendre.leggauss(64)
    t = 0.5 * (x + 1.0)
    wq = 0.5 * wq
    e = np.exp(np.outer(_SLAB_T, t ** (1.0 / _SLAB_P)) - _SLAB_T[:, None])
    return ((e * wq[None, :]).sum(1) / _SLAB_P).astype(np.float32)


_SLAB_F = _slab_table()


def _embedded_slab(tau, hd_over_mu):
    """Surface brightness of an exponential emitter inside an exponential absorber."""
    return hd_over_mu * np.interp(np.clip(tau, 0, 400.0), _SLAB_T, _SLAB_F).astype(np.float32)


def _galactic_frame(pole_lat=0.48, pole_lon=1.15):
    p = np.array([np.cos(pole_lat) * np.sin(pole_lon), np.sin(pole_lat),
                  np.cos(pole_lat) * np.cos(pole_lon)], np.float32)
    p /= np.linalg.norm(p)
    tmp = np.array([0.0, 1.0, 0.0], np.float32)
    if abs(float(p @ tmp)) > 0.9:
        tmp = np.array([1.0, 0.0, 0.0], np.float32)
    e1 = np.cross(p, tmp); e1 /= np.linalg.norm(e1)
    e2 = np.cross(p, e1)
    return p, e1, e2


def build_sky(w, h, seed, n_stars=55000, field_div=2):
    rng = np.random.default_rng(seed)
    fh, fw = h // field_div, w // field_div
    x, y, z, lat, lon = G.equirect_dirs(fw, fh)
    X = np.broadcast_to(x, (fh, fw)).astype(np.float32)
    Y = np.broadcast_to(y, (fh, fw)).astype(np.float32)
    Z = np.broadcast_to(z, (fh, fw)).astype(np.float32)

    pole, e1, e2 = _galactic_frame()
    sb = X * pole[0] + Y * pole[1] + Z * pole[2]              # sin(galactic latitude)
    gb = np.arcsin(np.clip(sb, -1, 1))
    gl = np.arctan2(X * e2[0] + Y * e2[1] + Z * e2[2],
                    X * e1[0] + Y * e1[1] + Z * e1[2])

    # ---------------------------------------------------------------- the band
    # Analytic integral of an exponential disc seen from inside it, attenuated by a
    # SECOND exponential disc of dust. The whole structure of the Milky Way's
    # appearance falls out of one fact: the dust scale height (125 pc) is 2.4x
    # SMALLER than the stellar scale height (300 pc). Looking along b = 0 you stare
    # down the dust lane and it is opaque within about a kiloparsec; a few degrees
    # off the plane you climb out of the dust while still cutting through plenty of
    # stars. So the surface brightness peaks OFF the midplane -- at about +3 deg,
    # +5 deg toward the centre -- with a shallow depression ON it. A single-scale-
    # height model gives a smooth featureless streak and is the reason most
    # procedural skies look wrong.
    KAPPA = 0.8 / 1.0857                            # A_V 0.8 mag/kpc -> tau/kpc
    sb = np.maximum(np.abs(np.sin(gb)), 3e-3)
    # longitude weighting: bright and wide toward the centre, thin toward the anticentre
    lonw = (1.0 + 2.0 * np.clip(np.cos(gl), 0, None) ** 1.5 +
            0.45 * np.exp(-((np.abs(gl) - 1.40) / 0.44) ** 2))      # + a Cygnus star cloud
    bulge = 1.8 * np.exp(-0.5 * ((gl / 0.157) ** 2 + (gb / 0.113) ** 2))
    # NOTE: the emissivity gets the full longitude weighting but the optical depth
    # only its square root. Applying `lonw` to both puts the band maximum at
    # sin(b) = KAPPA*H_DUST*lonw = 18 deg and leaves the inner band black; the
    # real maximum is at about +6 deg toward the centre.
    tau = KAPPA * H_DUST / sb * np.sqrt(lonw)
    # EMITTERS EMBEDDED IN THE ABSORBER, not behind it. The previous form was
    # (stellar integral) * exp(-tau_total), i.e. every photon crossing the full dust
    # column -- which drives the midplane to exactly zero and is why the band baked
    # out as a black snake with a thin glowing rim instead of as a band. The stars are
    # IN the dust layer, so the nearby ones arrive unextincted and the correct
    # transfer saturates instead of vanishing:
    #     I = int_0^inf j0 e^(-z/Hs) exp(-tau(s)) ds,  tau(s) = T (1 - e^(-s mu/Hd))
    #       = (j0 Hd / mu) e^-T int_0^1 u^(p-1) e^(Tu) du,   p = Hd/Hs = 0.417
    # which tends to j0 Hs/mu when T -> 0 (the unobscured disc integral) and to the
    # source function j0/alpha0 when T -> inf. The two scale heights still do all the
    # work and the peak is still OFF the plane -- at b ~ 3 deg -- but the midplane now
    # sits 14% below that peak rather than at zero, which is what the real band does.
    # The rift is then what it is in the sky: discrete foreground clouds, below.
    band = _embedded_slab(tau, H_DUST / sb) * lonw + bulge * np.exp(-np.clip(tau, 0, 30.0))

    # unresolved starlight is clumpy, and clumpier in the plane
    clump = 0.55 + 0.75 * (0.5 + 0.5 * G.fbm3(X * 3.4, Y * 3.4, Z * 3.4, 6, seed=seed + 12))
    band = band * clump
    band = np.power(np.maximum(band, 0.0), 1.40)

    # ---------------------------------------------------------------- dark rift
    wx, wy, wz = G.warp3(X * 2.2, Y * 2.2, Z * 2.2, amount=0.75, freq=0.8, seed=seed + 300)
    rift = G.ridged3(wx * 1.9, wy * 1.9, wz * 1.9, 6, seed=seed + 41)
    rift = np.clip(rift * 1.85 - 0.72, 0, 1) ** 1.5
    # dust lives IN the disc: confine it to low galactic latitude
    # The Great Rift is a LANE three to five degrees wide, not a swath. Confined to
    # sigma = 12.6 deg (as it was) it covers the entire bright core of the band, and
    # since the band peaks at |b| ~ 6 deg the result is that the dust eats exactly the
    # part that was supposed to glow -- the band read as a black snake with a thin
    # halo rather than as a glowing band with a crack in it.
    rift = rift * np.exp(-(gb / 0.105) ** 2)
    rift = rift + 0.22 * np.clip(G.billow3(X * 5.5, Y * 5.5, Z * 5.5, 5, seed=seed + 66) * 1.6 - 0.5,
                                 0, 1) * np.exp(-(gb / 0.165) ** 2)
    av = np.clip(rift * 1.75, 0, 3.0)

    # ---------------------------------------------------------------- dark nebulae
    # Named, discrete, SHARP-EDGED clouds silhouetted on the band, on top of the
    # smooth dust disc above. The smooth rift is a continuum of extinction and it can
    # only ever read as haze; what makes the real Milky Way look three-dimensional is
    # that the Coalsack and the Pipe have edges you can point at, and that they are
    # opaque -- A_V of 5-20 mag, i.e. nothing gets through at all, not a dimming.
    # Their boundaries are genuinely sharp because a molecular cloud is pressure
    # confined, so the shape is a hard threshold on warped ridged noise rather than a
    # soft envelope, and the envelope only decides WHERE the threshold can be crossed.
    for (cl_, cb_, sz, elong, cpa, avmax, so) in (
            (0.58, -0.030, 0.058, 2.9, 0.42, 7.0, 1),      # a Pipe/Snake-like lane
            (0.30, 0.062, 0.034, 1.3, -0.3, 5.0, 2),
            (-0.26, -0.012, 0.040, 1.7, 0.9, 6.0, 3),
            (1.48, -0.042, 0.044, 2.2, -0.75, 5.0, 4),     # a Coalsack
            (-1.34, 0.026, 0.062, 3.4, 0.22, 4.0, 5),
            (2.60, 0.038, 0.031, 1.5, 1.15, 3.5, 6)):
        dgl = np.mod(gl - cl_ + np.pi, TAU) - np.pi
        du = (dgl * np.cos(cb_) * np.cos(cpa) + (gb - cb_) * np.sin(cpa)) / (sz * elong)
        dv = (-dgl * np.cos(cb_) * np.sin(cpa) + (gb - cb_) * np.cos(cpa)) / sz
        er = np.sqrt(du * du + dv * dv)
        if er.min() > 2.2:
            continue
        env = np.exp(-er ** 2.1)
        s3 = seed + 7700 + so * 53
        qx, qy, qz = G.warp3(X * 4.5, Y * 4.5, Z * 4.5, amount=0.55, freq=3.0, seed=s3)
        lob = G.ridged3(qx * 5.2, qy * 5.2, qz * 5.2, 6, seed=s3 + 7)
        av = av + avmax * G.smoothstep(0.54, 0.655, env * (0.52 + 0.80 * lob))

    av = np.clip(av, 0, 12.0)
    trans = np.power(10.0, -0.4 * av[..., None] * EXT_RGB[None, None, :])

    # band colour: cool blue-white away from the centre, warm toward the bulge
    bandcol = (np.array([0.52, 0.62, 0.86], np.float32)[None, None, :] +
               np.array([0.46, 0.22, -0.30], np.float32)[None, None, :] * bulge[..., None])
    img = band[..., None] * bandcol * 0.034

    # ---------------------------------------------------------------- nebulae
    # placed in or near the plane, because that is where the gas is
    # Well separated in longitude, and each one dominated by a DIFFERENT emission
    # mechanism. Six overlapping rose complexes strung along the band read as one
    # continuous pink ribbon, which is the nebula equivalent of the fog problem.
    specs = [
        # (gl, gb, size, teal, rose, amber, strength, seedoff)
        (0.30, 0.06, 0.34, 1.00, 0.30, 0.10, 1.00, 1),   # OIII-dominated, near the core
        (-1.55, -0.10, 0.26, 0.15, 1.00, 0.30, 0.85, 2),  # Halpha
        (2.45, 0.12, 0.30, 0.45, 0.30, 1.00, 0.70, 3),   # dusty reflection
        (-2.75, 0.04, 0.22, 1.00, 0.35, 0.15, 0.65, 4),
        (1.30, -0.26, 0.20, 0.25, 1.00, 0.45, 0.60, 5),
    ]
    TEAL = np.array([0.16, 0.86, 0.80], np.float32)
    ROSE = np.array([1.00, 0.26, 0.46], np.float32)
    AMBER = np.array([1.00, 0.62, 0.24], np.float32)

    for (cl_, cb_, sz, wt, wr, wa, stren, so) in specs:
        cd = (np.cos(cb_) * np.cos(cl_) * e1 + np.cos(cb_) * np.sin(cl_) * e2 +
              np.sin(cb_) * pole)
        cosang = np.clip(X * cd[0] + Y * cd[1] + Z * cd[2], -1, 1)
        ang = np.arccos(cosang)
        env = np.exp(-(ang / sz) ** 2)
        if env.max() < 1e-4:
            continue
        s2 = seed + 900 + so * 37
        # two-level domain warp then RIDGED noise: filaments, not fog
        qx, qy, qz = G.warp3(X * 3.0, Y * 3.0, Z * 3.0, amount=0.60, freq=1.1, seed=s2)
        rx, ry, rz = G.warp3(qx, qy, qz, amount=0.35, freq=2.3, seed=s2 + 17)
        fil = G.ridged3(rx * 2.4, ry * 2.4, rz * 2.4, 6, seed=s2 + 5)
        # threshold + power: noise with mean 0.5 literally IS grey fog. Real nebula
        # images are >80% black, so the transfer curve has to be sparse, and the
        # non-linearity belongs on DENSITY, before emission, not on the final colour.
        dens = np.clip((fil - 0.40) / 0.60, 0, 1) ** 2.2 * env

        # cavity: a smooth low-frequency field that EATS the density and whose rim is
        # brightened. Emission nebulae are shells around hot stars, not solid lumps;
        # the bright rim around a hollow is most of what reads as three-dimensional.
        cav = 0.5 + 0.5 * G.fbm3(X * 2.6 + 11.0, Y * 2.6, Z * 2.6, 4, seed=s2 + 71)
        shell = np.exp(-((cav - 0.56) / 0.09) ** 2)
        hollow = G.smoothstep(0.50, 0.72, cav)
        dens = dens * (1.0 - 0.75 * hollow) + 0.55 * shell * env * np.clip(fil, 0, 1)

        col = (wt * TEAL[None, None, :] * (hollow[..., None] * 0.8 + 0.2) +
               wr * ROSE[None, None, :] * (1.0 - hollow[..., None] * 0.6) +
               wa * AMBER[None, None, :] * 0.45)
        col = col / (wt + wr + wa)
        img += dens[..., None] * col * (0.62 * stren)

    # extinguish everything diffuse behind the dust
    img = img * trans

    # ---------------------------------------------------------------- upsample
    img = np.clip(_upsample(img, field_div, field_div), 0, None)
    if img.shape[0] != h or img.shape[1] != w:
        img = img[:h, :w]

    # ---------------------------------------------------------------- deep field
    distant_galaxies(img, pole, e1, e2, rng, w, h, n=int(52 * (w / 4096.0) ** 0.6))

    # ---------------------------------------------------------------- stars
    # Direction: a disc-concentrated population plus an isotropic one. Sampling the
    # sphere uniformly (rather than uniformly in uv) is what keeps the pole regions
    # from turning into a dense cap.
    n_disc = int(n_stars * 0.30)
    n_iso = n_stars - n_disc
    d1 = _sample_disc_dirs(n_disc, pole, e1, e2, rng)
    v = rng.normal(size=(n_iso, 3))
    d2 = (v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float32)
    dirs = np.concatenate([d1, d2])

    # Luminosity function. Observed counts go as N(<m) ~ 10^(0.49 m) over m = 2..12,
    # NOT the 10^(0.6 m) of a homogeneous infinite distribution (the disc has a finite
    # thickness and ~0.8 mag/kpc of extinction in the plane). Converting to flux,
    # P(F > f) ~ f^-1.225, so invert that.
    flux = (1.0 - rng.random(len(dirs))) ** (-1.0 / 1.225) - 1.0
    flux = np.minimum(flux, 2200.0) / 2200.0

    # Spectral mix must be MAGNITUDE-limited, not volume-limited. By volume 76% of
    # stars are M dwarfs and 0.6% are OBA; in a naked-eye sky it is the other way
    # round -- OBA make up ~42% of what you can see and M only 6%, because an O star
    # is sampled over a volume 10^6 times larger. Getting this backwards is what
    # makes a procedural starfield look orange instead of blue-white.
    frac = np.array([0.006, 0.196, 0.217, 0.143, 0.133, 0.246, 0.060])
    bv_lo = np.array([-0.33, -0.30, -0.02, 0.30, 0.58, 0.82, 1.42])
    bv_hi = np.array([-0.30, -0.02, 0.30, 0.58, 0.82, 1.42, 1.90])
    cls = rng.choice(7, size=len(dirs), p=frac / frac.sum())
    bv = bv_lo[cls] + (bv_hi[cls] - bv_lo[cls]) * rng.random(len(dirs))
    # Ballesteros is good to ~5% for -0.1 < B-V < 1.5 but saturates near 16000 K, so
    # early types get their tabulated temperature instead of the formula's answer.
    temp = 4600.0 * (1.0 / (0.92 * bv + 1.70) + 1.0 / (0.92 * bv + 0.62))
    hot = bv < -0.10
    temp[hot] = 12000.0 + 26000.0 * ((-0.10 - bv[hot]) / 0.23) ** 1.6
    scol = G.blackbody_rgb(np.clip(temp, 2400, 38000))
    scol = scol * 0.62 + 0.38                        # desaturate: real starfields are pale

    slat = np.arcsin(np.clip(dirs[:, 1], -1, 1))
    slon = np.arctan2(dirs[:, 0], dirs[:, 2])
    sx = (slon / np.pi * 0.5 + 0.5) * w
    sy = (0.5 - slat / np.pi) * h

    # extinction on the star field too, sampled from the same dust map
    av_s = _sample_map(av, sx / w, sy / h)
    # nearby/bright stars sit in front of most of the dust
    frac = np.clip(1.0 - flux * 3.0, 0.0, 1.0)
    stx = np.power(10.0, -0.4 * (av_s * frac)[:, None] * EXT_RGB[None, :])
    scol = scol * stx

    coslat = np.maximum(np.cos(slat), 1.0 / (w / 2.0))
    base = max(0.62, w / 4096.0 * 0.72)
    rad = base * (1.0 + 1.9 * flux ** 0.5)
    ry = rad
    rx = np.minimum(rad / coslat, w * 0.010)

    amp = 0.030 + 2.4 * flux ** 1.15
    G.splat_gauss(img, sx, sy, rx, ry, amp, scol, wrap_x=True)
    # a broad faint halo on the brighter half: a pure gaussian core reads as a hard
    # dot, the halo is what makes a star look like a star at any zoom
    big = flux > 0.02
    if big.any():
        G.splat_gauss(img, sx[big], sy[big], rx[big] * 3.4, ry[big] * 3.4,
                      amp[big] * 0.055, scol[big], wrap_x=True)
    # The brightest handful get drawn as RESOLVED objects rather than as splats: a
    # wider halo on top of the core (the halo is what the eye reads as brightness once
    # the core has clipped) and four diffraction spikes at a shared angle.
    order = np.argsort(-flux)[:22]
    G.splat_gauss(img, sx[order], sy[order], rx[order] * 8.5, ry[order] * 8.5,
                  amp[order] * 0.010, scol[order], wrap_x=True)
    _spikes(img, sx[order], sy[order], rad[order], amp[order], scol[order], coslat[order],
            arms=4, roll=0.37)

    return np.clip(img, 0.0, None)


def _sample_map(field, u, v):
    fh, fw = field.shape
    yi = np.clip((v * fh).astype(int), 0, fh - 1)
    xi = np.clip((u * fw).astype(int), 0, fw - 1)
    return field[yi, xi]


def _sample_disc_dirs(n, pole, e1, e2, rng):
    """Directions concentrated toward the galactic plane: a sech-like latitude
    distribution, uniform in galactic longitude but weighted toward the centre."""
    b = rng.laplace(0.0, 0.16, n)
    b = np.clip(b, -np.pi / 2 + 1e-3, np.pi / 2 - 1e-3)
    lon = rng.random(n) * 2 * np.pi - np.pi
    keep = rng.random(n) < (0.45 + 0.55 * np.exp(-(lon / 0.9) ** 2))
    lon = np.where(keep, lon, rng.random(n) * 2 * np.pi - np.pi)
    d = (np.cos(b)[:, None] * np.cos(lon)[:, None] * e1[None, :] +
         np.cos(b)[:, None] * np.sin(lon)[:, None] * e2[None, :] +
         np.sin(b)[:, None] * pole[None, :])
    return (d / np.linalg.norm(d, axis=1, keepdims=True)).astype(np.float32)


def _spikes(img, xs, ys, rad, amp, cols, coslat, arms=4, roll=0.0):
    """Diffraction spikes on the brightest stars only.

    Two things were wrong with doing this by writing integer pixels along a row and a
    column, which is what the previous version did. It can only draw at 0 and 90
    degrees, so every bright star carried the same upright cross and the frame looked
    stamped; and a one-pixel-wide hard write has no anti-aliasing at all, so at 4K the
    spikes were visibly staircased. Here each arm is a chain of overlapping gaussians
    laid along an arbitrary direction, which is sub-pixel accurate at any angle and
    costs a few thousand tiny splats for the whole sky.

    The physics that matters for the look: the spike is the Fourier transform of the
    aperture's support vanes, so a four-vane spider gives four arms at 90 degrees and
    the pattern rotates rigidly with the telescope -- the arms all share one angle,
    they are not random per star. Intensity falls roughly as 1/r along the arm rather
    than as a gaussian, which is why real spikes stay visible so far out; and because
    the diffraction angle scales with wavelength, the arms redden outward. All three
    are cheap and all three are what sells it.
    """
    H, W = img.shape[:2]
    base = np.arange(arms, dtype=np.float32) * (np.pi / arms) + roll
    for i in range(len(xs)):
        L = float(rad[i]) * 17.0
        if L < 4.0:
            continue
        cl = max(float(coslat[i]), 0.04)
        sig = max(0.52, float(rad[i]) * 0.34)
        step = sig * 0.80
        n = int(L / step)
        if n < 4:
            continue
        t = (np.arange(1, n + 1, dtype=np.float32)) * step
        # 1/r core with an outer cut-off, and a mild reddening with distance out
        fall = (1.0 / (1.0 + (t / (L * 0.16)) ** 1.35)) * np.exp(-(t / L) ** 3)
        fall = fall * float(amp[i]) * 0.055 * (step / max(sig, 1e-3))
        c0 = np.asarray(cols[i], np.float32)
        red = np.clip(t / L, 0, 1)[:, None] * np.array([0.35, -0.05, -0.30], np.float32)
        c = np.clip(c0[None, :] * (1.0 + red), 0, None)
        for a in base:
            ca, sa = float(np.cos(a)), float(np.sin(a))
            for sgn in (+1.0, -1.0):
                px = xs[i] + sgn * t * ca / cl
                py = ys[i] + sgn * t * sa
                keep = (py >= -3) & (py < H + 3)
                if not keep.any():
                    continue
                G.splat_gauss(img, px[keep], py[keep],
                              np.full(keep.sum(), sig / cl), np.full(keep.sum(), sig),
                              fall[keep], c[keep], cutoff=2.6, wrap_x=True)


def _splat_ellipse(img, cx, cy, a, b, pa, amp, colour, index=1.0, cutoff=3.2, dust=0.0,
                   kx=1.0):
    """One rotated elliptical blob with an r^(1/index) Sersic-ish profile.

    splat_gauss only does axis-aligned ellipses, which is fine for stars (where the
    stretch is always along u) and useless for galaxies, whose whole read is that each
    one is a little ellipse at its OWN random angle. `dust` cuts a dark lane along the
    major axis, which is the only cue that makes a highly flattened one read as an
    edge-on disc rather than as a smudge.
    """
    H, W = img.shape[:2]
    ext = int(np.ceil(max(a, b) * cutoff)) + 1
    extx = min(int(np.ceil(ext / max(kx, 1e-3))), W // 2)
    y0, y1 = max(0, int(cy) - ext), min(H, int(cy) + ext + 1)
    if y1 <= y0:
        return
    xs = np.arange(int(cx) - extx, int(cx) + extx + 1)
    yy, xx = np.meshgrid(np.arange(y0, y1, dtype=np.float32),
                         xs.astype(np.float32), indexing="ij")
    # kx = cos(lat): work in sphere metric so the blob stays round/elliptical ON THE
    # SPHERE while being drawn stretched across the equirect plate.
    dx, dy = (xx - cx) * kx, yy - cy
    ct, st = np.cos(pa), np.sin(pa)
    u = (dx * ct + dy * st) / a
    v = (-dx * st + dy * ct) / b
    r = np.sqrt(u * u + v * v)
    prof = np.exp(-7.67 * (np.maximum(r, 1e-3) ** (1.0 / index) - 1.0) * 0.55)
    prof = prof * np.exp(-(r / cutoff) ** 4)
    if dust > 0.0:
        prof = prof * (1.0 - dust * np.exp(-(((-dx * st + dy * ct) / (b * 0.30)) ** 2)))
    patch = prof[..., None] * (np.asarray(colour, np.float32) * np.float32(amp))
    np.add.at(img, (slice(y0, y1), np.mod(xs, W)), patch)


def _dir_to_px(d, w, h):
    lat = np.arcsin(np.clip(d[1], -1, 1))
    lon = np.arctan2(d[0], d[2])
    return (lon / np.pi * 0.5 + 0.5) * w, (0.5 - lat / np.pi) * h, max(np.cos(lat), 1e-3)


def _gal_dir(gl, gb, pole, e1, e2):
    return (np.cos(gb) * np.cos(gl) * e1 + np.cos(gb) * np.sin(gl) * e2 + np.sin(gb) * pole)


def distant_galaxies(img, pole, e1, e2, rng, w, h, n=52):
    """Faint external galaxies, plus two satellite irregulars.

    These are the cheapest depth cue there is: a star is a point at an unknowable
    distance, but a resolvable disc is unmistakably far away, and once a few are in
    frame the rest of the sky reads as a volume rather than as a wall.

    Three observational facts shape the placement and the look:
      * the ZONE OF AVOIDANCE. Galaxy counts fall to zero within about 10 deg of the
        galactic plane, because that is where the dust is. Sprinkling them uniformly
        -- including across the band -- is the giveaway, so nothing is drawn below
        |b| = 16 deg and the count is weighted to the galactic poles.
      * the mix is mostly early types and small spirals at 2-6 px, with a steep size
        distribution, so a handful are large enough to show a shape and the rest are
        just non-stellar fuzz. Non-stellar is the whole point: they must NOT look
        like stars, so every one gets a Sersic profile and a random position angle.
      * flattened ones get a dust lane down the major axis, which is the only thing
        that makes an edge-on disc read as a disc rather than as a scratch.
    """
    for _ in range(n):
        for _try in range(24):
            v = rng.normal(size=3)
            d = (v / np.linalg.norm(v)).astype(np.float32)
            sb = float(d @ pole)
            if abs(sb) > 0.27:
                break
        if abs(float(d @ pole)) <= 0.27:
            continue
        cx, cy, cl = _dir_to_px(d, w, h)
        scale = w / 4096.0
        a = min(1.6 + 6.5 * (1.0 - rng.random()) ** (-1.0 / 2.4) - 1.6, 26.0) * scale + 1.3 * scale
        q = float(np.clip(rng.beta(2.2, 2.0), 0.14, 1.0))
        pa = float(rng.uniform(0, np.pi))
        spiral = rng.random() < 0.58
        index = 1.0 if spiral else 4.0
        col = (np.array([0.84, 0.88, 1.00], np.float32) if spiral
               else np.array([1.00, 0.88, 0.72], np.float32))
        col = col * (0.85 + 0.3 * rng.random())
        amp = (0.004 + 0.030 * (1.0 - rng.random()) ** 2.2) * (1.0 if spiral else 1.35)
        dust = 0.55 if (spiral and q < 0.30) else 0.0
        _splat_ellipse(img, cx, cy, a, max(a * q, 0.8 * scale), pa, amp, col,
                       index=index, dust=dust, kx=cl)
        if spiral and a > 7 * scale and q > 0.45:
            # a brighter nucleus on the ones big enough to show one
            G.splat_gauss(img, np.array([cx]), np.array([cy]),
                          np.array([max(a * 0.16, 0.7) / cl]), np.array([max(a * 0.16, 0.7)]),
                          np.array([amp * 2.4]), col[None, :], wrap_x=True)

    # ------------------------------------------------- satellite irregulars
    # Magellanic analogues: resolved, barred, and carrying one giant HII complex each
    # (the 30 Doradus of this sky). They are the single most recognisable thing that
    # can sit off the band, and unlike the distant galaxies they are drawn as actual
    # STARS, because at this plate scale a nearby satellite is resolved and a smooth
    # blob would read as a thumbprint.
    scale = w / 4096.0
    for (gl_, gb_, size, elong, pa, nst, knots, bright) in (
            (-2.05, -0.62, 0.150, 1.45, 0.7, 5200, 11, 1.00),
            (-2.52, -0.86, 0.090, 1.20, -0.4, 1900, 5, 0.72)):
        cd = _gal_dir(gl_, gb_, pole, e1, e2)
        cx, cy, cl = _dir_to_px(cd, w, h)
        rpx = size * (w / (2 * np.pi))
        nst = int(nst * scale ** 2 * 4)
        ct, st = np.cos(pa), np.sin(pa)
        u = rng.normal(0, 0.52, nst) * elong
        v = rng.normal(0, 0.52, nst)
        # an off-centre bar, which is what makes an irregular read as irregular
        barm = rng.random(nst) < 0.30
        u[barm] = rng.normal(0.12, 0.34, barm.sum()) * elong
        v[barm] = rng.normal(-0.05, 0.11, barm.sum())
        px = cx + (u * ct - v * st) * rpx / cl
        py = cy + (u * st + v * ct) * rpx
        f = (1.0 - rng.random(nst)) ** 2.6
        sc = np.clip(np.array([0.80, 0.86, 1.00], np.float32)[None, :] *
                     (0.80 + 0.45 * rng.random((nst, 1))), 0, 1)
        srad = np.full(nst, max(0.60, 0.62 * scale))
        G.splat_gauss(img, px, py, srad / cl, srad, 0.020 * bright * f, sc, wrap_x=True)
        _splat_ellipse(img, cx, cy, rpx * 0.95 * elong, rpx * 0.95, pa,
                       0.0075 * bright, np.array([0.78, 0.84, 1.00], np.float32),
                       index=1.0, kx=cl)
        ku = rng.normal(0, 0.45, knots) * elong
        kv = rng.normal(0, 0.45, knots)
        kpx = cx + (ku * ct - kv * st) * rpx / cl
        kpy = cy + (ku * st + kv * ct) * rpx
        kr = np.maximum((0.9 + 2.6 * rng.random(knots)) * scale, 0.9)
        kr[0] *= 2.4                                       # the 30 Dor of this satellite
        ka = 0.030 * bright * (0.4 + rng.random(knots))
        ka[0] *= 2.8
        G.splat_gauss(img, kpx, kpy, kr / cl, kr, ka,
                      np.broadcast_to(np.array([1.00, 0.42, 0.52], np.float32), (knots, 3)),
                      wrap_x=True)
    return img


def normalise_sky(img, target_mean=0.085, p999_cap=0.62, hot_frac=0.0006):
    """Scale and soft-clip so the broad sky sits far below the runtime bloom threshold.

    Measured, not guessed: the brief's whole point about the sky is that it must not
    trip bloom, and 'looks dim' is not a measurement.
    """
    lum = img @ LUMW
    cur = float(lum.mean())
    if cur > 1e-6:
        img = img * (target_mean / cur)
    lum = img @ LUMW
    # soft shoulder above p999_cap so star cores roll off instead of clipping to white
    over = lum > p999_cap
    if over.any():
        k = np.ones_like(lum)
        k[over] = (p999_cap + (lum[over] - p999_cap) / (1.0 + (lum[over] - p999_cap) * 1.6)) / lum[over]
        img = img * k[..., None]
    return np.clip(img, 0, 1)

# ==========================================================================
# the courier craft
# ==========================================================================

HULL_DARK = (0.085, 0.095, 0.120)
HULL_MID = (0.190, 0.208, 0.245)
HULL_LIGHT = (0.470, 0.500, 0.555)
CERAMIC = (0.760, 0.780, 0.830)
TRIM = (0.13, 0.72, 1.00)
CANOPY = (0.45, 0.86, 1.00)
THROAT = (1.00, 0.58, 0.18)
PLUME = (1.00, 0.88, 0.62)
GREEN = (0.20, 1.00, 0.45)
RED = (1.00, 0.28, 0.30)

SEG = 30


# ------------------------------------------------------------------ profiles
def _hull_profile():
    """Long ogive nose (55% of the length) -> short parallel mid-body -> boat-tail.

    A von Karman-ish ogive rather than a cone: the cone tip plus cylinder that the old
    asset used is the single most 'untouched primitive' shape there is, and at 30 px it
    reads as a pencil. The two radius steps (payload collar, engine mount break) give
    the outline a shoulder and a waist so it reads as built rather than turned.
    """
    return [
        (1.000, 0.0000),
        (0.982, 0.0155),
        (0.950, 0.0320),
        (0.900, 0.0520),
        (0.830, 0.0715),
        (0.740, 0.0895),
        (0.630, 0.1045),
        (0.500, 0.1155),
        (0.360, 0.1225),
        (0.200, 0.1258),
        (0.170, 0.1355),      # payload collar: shoulder
        (0.060, 0.1370),
        (0.030, 0.1250),
        (-0.230, 0.1235),
        (-0.380, 0.1180),
        (-0.402, 0.1010),     # engine mount break: waist
        (-0.520, 0.0975),
        (-0.600, 0.0930),
    ]


def _bell_profile():
    """Converging-diverging nozzle. The lip is a touch wider than the hull -- enough to
    plant a flare at the tail, not so much that the craft reads as a megaphone (the
    first cut used a 2.3x lip and that is exactly what it looked like)."""
    return [
        (-0.600, 0.0930),
        (-0.650, 0.0720),     # throat
        (-0.700, 0.0880),
        (-0.780, 0.1160),
        (-0.860, 0.1400),
        (-0.925, 0.1560),
        (-0.955, 0.1630),     # lip
    ]


def _wing_outline():
    """(z, span) planform of the starboard wing: cranked-delta, straight trailing edge,
    clipped tip at 0.60 -- four and a half hull radii, so the wings and not the body set
    the width of the silhouette. The crank at 0.30 span breaks the pure triangle, which
    is what stops it reading as a paper dart."""
    return [
        (0.330, 0.085),       # leading root
        (0.190, 0.300),
        (0.010, 0.460),
        (-0.190, 0.600),      # leading tip
        (-0.330, 0.600),      # trailing tip
        (-0.315, 0.420),
        (-0.345, 0.230),
        (-0.395, 0.085),      # trailing root
    ]


def _wing_edge_outline():
    """A sliver hugging the wing leading edge -- the emissive strip."""
    return [
        (0.245, 0.190), (0.100, 0.365), (0.010, 0.460), (-0.190, 0.600),
        (-0.224, 0.598), (-0.030, 0.452), (0.068, 0.358), (0.216, 0.186),
    ]


def _canard_outline():
    """A small swept foreplane just aft of the payload collar.

    The single thing this adds is a SECOND span in the outline, forward of the main
    one. At thirty pixels the craft is two or three bright marks and a dark shape, and
    a shape that goes narrow-wide-narrow-wide-narrow along its length is read as a
    built vehicle; one that just goes narrow-wide-narrow is read as a dart. It costs
    twenty triangles.
    """
    return [
        (0.560, 0.100),
        (0.505, 0.180),
        (0.430, 0.255),
        (0.372, 0.258),
        (0.392, 0.176),
        (0.432, 0.100),
    ]


def _nacelle_profile():
    """Outboard engine pod: ogive front, parallel body, boat-tail into its own bell."""
    return [
        (0.100, 0.0000),
        (0.072, 0.0225),
        (0.020, 0.0410),
        (-0.090, 0.0530),
        (-0.360, 0.0530),
        (-0.470, 0.0495),
        (-0.545, 0.0410),
        (-0.580, 0.0330),     # throat
        (-0.640, 0.0450),
        (-0.690, 0.0545),     # lip
    ]


def _fin_outline(h, z_lead, z_trail, sweep, root=0.012):
    return [
        (z_lead, root),
        (z_lead - sweep * 0.40, h * 0.60),
        (z_lead - sweep, h),
        (z_trail + 0.035, h * 0.88),
        (z_trail, root),
    ]


# ------------------------------------------------------------------ shading helpers
def _lathe_colours(prof, nverts, seg, band_fn, extra=0):
    """Per-vertex colour for a lathe: a radial band function plus a dorsal/ventral
    gradient and a 6-fold panel ripple. Vertex colours interpolate across a smooth
    lathe, so these land as soft tone changes rather than lines -- which is correct
    here: a hard panel line at this size aliases into a crawling dotted edge."""
    cols = np.zeros((nverts, 3))
    vi = 0
    th = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    dors = 0.5 + 0.5 * np.sin(th)
    for (z, r) in prof:
        base = np.asarray(band_fn(z, r), float)
        if r <= 1e-9:
            cols[vi] = base
            vi += 1
            continue
        panel = 0.93 + 0.07 * np.cos(6 * th + z * 4.0)
        f = (0.72 + 0.50 * dors) * panel
        cols[vi:vi + seg] = base[None, :] * f[:, None]
        vi += seg
    for k in range(vi, nverts):
        cols[k] = np.asarray(band_fn(prof[-1][0], prof[-1][1]), float) * 0.8
    return np.clip(cols, 0, 1)


def _lerp(a, b, t):
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3))


# ------------------------------------------------------------------ build
def build_rocket():
    m = M.Mesh()

    # -------------------------------------------------------------- fuselage
    prof = _hull_profile()
    v, f = M.lathe(prof, SEG, close_end=True)
    v, f = M.orient_outward(v, f)

    def bands(z, r):
        if z > 0.905:
            return CERAMIC
        if z > 0.760:
            return _lerp(HULL_LIGHT, CERAMIC, (z - 0.760) / 0.145)
        if 0.045 < z <= 0.185:
            return HULL_DARK                      # collar reads as a dark ring
        if z < -0.390:
            return HULL_DARK
        if z < -0.200:
            return _lerp(HULL_MID, HULL_DARK, (-0.200 - z) / 0.190)
        return HULL_MID

    m.add(v, f, _lathe_colours(prof, len(v), SEG, bands), 0.0, crease=34.0)

    # ------------------------------------------------- hull trim strips
    # Emissive strips that FOLLOW the hull curvature (see hull_strip): one
    # dorsal spine and two flanks. Tangent flat plates were tried first and read as
    # stickers glued to the side -- the curvature is what makes them look inlaid.
    for (tc, hw, z0, z1, gl) in ((np.pi / 2, 0.26, -0.36, 0.20, 1.7),
                                 (0.0, 0.24, -0.36, 0.55, 1.7),
                                 (np.pi, 0.24, -0.36, 0.55, 1.7)):
        hv, hf = M.hull_strip(prof, tc, hw, dr=1.055, nseg=5, zrange=(z0, z1))
        hv, hf = M.orient_outward(hv, hf)
        m.add(hv, hf, TRIM, gl, crease=None)

    # -------------------------------------------------------------- wings
    for sx in (+1, -1):
        wv, wf = M.plate(_wing_outline(), 0.030, "h")
        wv = M.transform(wv, rot=[(2, np.radians(-6.0))])          # slight anhedral
        wv = M.transform(wv, mirror_x=(sx < 0), translate=(0.0, -0.016, 0.0))
        wv, wf = M.orient_outward(wv, wf)
        tip = np.clip(np.abs(wv[:, 0]) / 0.60, 0, 1)
        wc = np.array([_lerp(HULL_MID, HULL_DARK, t) for t in tip])
        wc[wv[:, 1] > -0.016] *= 1.75                               # upper skin catches the key
        m.add(wv, wf, np.clip(wc, 0, 1), 0.0, crease=None)

        ev, ef = M.plate(_wing_edge_outline(), 0.040, "h")
        ev = M.transform(ev, rot=[(2, np.radians(-6.0))])
        ev = M.transform(ev, mirror_x=(sx < 0), translate=(0.0, -0.016, 0.0))
        ev, ef = M.orient_outward(ev, ef)
        m.add(ev, ef, TRIM, 1.1, crease=None)

        # ---------------------------------------------- wing-tip pod (already +Z)
        pod = [(0.075, 0.0), (0.045, 0.026), (-0.060, 0.044), (-0.230, 0.040),
               (-0.320, 0.026), (-0.345, 0.012)]
        pv, pf = M.lathe(pod, 12, close_end=True)
        pv, pf = M.orient_outward(pv, pf)
        pv = M.transform(pv, rot=[(2, np.radians(-6.0))],
                         translate=(0.585 * sx, -0.075, -0.235))
        pc = np.array([_lerp(HULL_DARK, HULL_LIGHT, t)
                       for t in np.clip((pv[:, 1] + 0.108) / 0.072, 0, 1)])
        m.add(pv, pf, np.clip(pc, 0, 1), 0.0, crease=40.0)

        # navigation light on the pod nose: starboard green, port red. Two coloured
        # points 1.17 hull-lengths apart are the strongest small-size read there is.
        nv, nf = M.lathe([(-0.005, 0.024), (0.030, 0.019), (0.050, 0.0)], 10, close_start=True)
        nv, nf = M.orient_outward(nv, nf)
        nv = M.transform(nv, translate=(0.585 * sx, -0.075, -0.172))
        m.add(nv, nf, GREEN if sx > 0 else RED, 2.8, crease=None)

    # -------------------------------------------------------------- V-tail
    # Two canted fins instead of one dorsal shark fin. A single fin is a strong
    # silhouette from the side and NOTHING from directly above or below, and these
    # craft are flown along curves that put the camera everywhere; a V always shows
    # two edges. It also widens the tail, which is what the eye uses to tell front
    # from back at thirty pixels.
    for sx in (+1, -1):
        fv, ff = M.plate(_fin_outline(0.330, -0.140, -0.545, 0.180), 0.024, "v",
                         offset=(0.0, 0.106, 0.0))
        fv = M.transform(fv, rot=[(2, np.radians(29.0) * sx)])
        fv, ff = M.orient_outward(fv, ff)
        hh = np.clip((np.hypot(fv[:, 0], fv[:, 1]) - 0.106) / 0.330, 0, 1)
        fc = np.array([_lerp(HULL_MID, HULL_LIGHT, t) for t in hh])
        m.add(fv, ff, np.clip(fc, 0, 1), 0.0, crease=None)
        cv, cf = M.plate([(-0.350, 0.420), (-0.288, 0.406), (-0.282, 0.436),
                          (-0.358, 0.447)], 0.026, "v")
        cv = M.transform(cv, rot=[(2, np.radians(29.0) * sx)])
        cv, cf = M.orient_outward(cv, cf)
        m.add(cv, cf, TRIM, 2.2, crease=None)
        # white strobe at each fin tip: with the wing-tip red/green these put four
        # emissive points at the four extremes of the silhouette
        a34 = np.radians(29.0) * sx
        tipx = -np.sin(a34) * 0.430
        tipy = np.cos(a34) * 0.430
        tv, tf = M.lathe([(-0.290, 0.0), (-0.310, 0.016), (-0.340, 0.012)], 8,
                         close_start=True, close_end=True)
        tv, tf = M.orient_outward(tv, tf)
        tv = M.transform(tv, translate=(tipx, tipy, 0.0))
        m.add(tv, tf, (1.0, 0.96, 0.90), 2.6, crease=None)

    # -------------------------------------------------------------- canards
    for sx in (+1, -1):
        kv, kf = M.plate(_canard_outline(), 0.022, "h")
        kv = M.transform(kv, rot=[(2, np.radians(9.0))])            # slight dihedral
        kv = M.transform(kv, mirror_x=(sx < 0), translate=(0.0, 0.004, 0.0))
        kv, kf = M.orient_outward(kv, kf)
        kc = np.where((kv[:, 1] > 0.004)[:, None],
                      np.array(HULL_LIGHT)[None, :], np.array(HULL_DARK)[None, :])
        m.add(kv, kf, np.clip(kc, 0, 1), 0.0, crease=None)

    # -------------------------------------------------------------- ventral strakes
    for sx in (+1, -1):
        sv, sf = M.plate(_fin_outline(0.190, -0.190, -0.500, 0.110), 0.022, "d",
                         offset=(0.0, -0.095, 0.0))
        sv = M.transform(sv, rot=[(2, np.radians(30.0) * sx)])
        sv, sf = M.orient_outward(sv, sf)
        m.add(sv, sf, HULL_DARK, 0.0, crease=None)

    # -------------------------------------------------------------- canopy
    # Half-ellipsoid pressed into the dorsal nose: the one feature that says 'crewed
    # vehicle' rather than 'missile', and the brightest thing forward of the tail.
    u = np.linspace(0.0, np.pi, 9)
    w = np.linspace(-np.pi / 2, np.pi / 2, 7)
    cvs = []
    for wi in w:
        for uj in u:
            cvs.append((np.cos(wi) * np.cos(uj) * 0.062,
                        np.sin(wi) * 0.060 + 0.108,
                        np.cos(wi) * np.sin(uj) * 0.190 + 0.492))
    nu, nw = len(u), len(w)
    cfs = []
    for i in range(nw - 1):
        for j in range(nu - 1):
            a = i * nu + j
            cfs.append((a, a + nu, a + nu + 1))
            cfs.append((a, a + nu + 1, a + 1))
    cvs = np.array(cvs); cfs = np.array(cfs)
    cvs, cfs = M.orient_outward(cvs, cfs)
    hi = np.clip((cvs[:, 1] - 0.078) / 0.082, 0, 1)
    cc = np.array([_lerp(HULL_DARK, CANOPY, t) for t in hi])
    m.add(cvs, cfs, np.clip(cc, 0, 1), np.clip(hi ** 1.3 * 3.0, 0, 3.2), crease=None)

    # -------------------------------------------------------------- engine bell
    bp = _bell_profile()
    bv, bf = M.lathe(bp, SEG)
    bv, bf = M.orient_outward(bv, bf)
    t = np.clip((bv[:, 2] + 0.955) / 0.305, 0, 1)                  # 0 lip -> 1 throat
    bc = np.array([_lerp(HULL_DARK, (0.36, 0.34, 0.35), ti) for ti in t])
    th = np.arctan2(bv[:, 1], bv[:, 0])
    bc *= (0.86 + 0.14 * np.cos((SEG // 2) * th))[:, None]         # nozzle stiffener ribs
    m.add(bv, bf, np.clip(bc, 0, 1), 0.0, crease=34.0)

    # Bell interior: a reversed cone of hot gas, seen only from behind -- which is
    # exactly where the camera is for the outbound leg of the bridge.
    iv, if_ = M.lathe([(-0.955, 0.158), (-0.870, 0.132), (-0.740, 0.092), (-0.663, 0.066)],
                      SEG, close_end=True)
    iv, if_ = M.orient_outward(iv, if_)
    if_ = M.flip(if_)
    ti = np.clip((iv[:, 2] + 0.955) / 0.292, 0, 1)
    ic = np.array([_lerp(THROAT, PLUME, x) for x in ti])
    m.add(iv, if_, ic, 1.3 + 2.2 * ti, crease=None)

    # -------------------------------------------------------------- outboard nacelles
    # Two pod engines on short pylons under the wings. The craft is seen from behind
    # for the whole outbound leg of every bridge run, and from there one bell on the
    # axis is a dot: three bells in a triangle, the outer two a third of the span
    # apart, is a shape. They also put mass outboard and low, which is most of what
    # separates a hauler from a fighter in one glance.
    nprof = _nacelle_profile()
    for sx in (+1, -1):
        nx = 0.330 * sx
        ny = -0.115
        nv, nf = M.lathe(nprof, 14)
        nv, nf = M.orient_outward(nv, nf)
        nv = M.transform(nv, translate=(nx, ny, -0.090))
        t = np.clip((nv[:, 2] + 0.780) / 0.880, 0, 1)
        nc = np.array([_lerp(HULL_DARK, HULL_MID, ti) for ti in t])
        nc = nc * (0.70 + 0.70 * np.clip((nv[:, 1] - ny + 0.053) / 0.106, 0, 1))[:, None]
        m.add(nv, nf, np.clip(nc, 0, 1), 0.0, crease=36.0)

        # hot throat, visible only from astern
        iv, if2 = M.lathe([(-0.690, 0.052), (-0.648, 0.042), (-0.600, 0.030),
                           (-0.572, 0.020)], 14, close_end=True)
        iv, if2 = M.orient_outward(iv, if2)
        if2 = M.flip(if2)
        iv = M.transform(iv, translate=(nx, ny, -0.090))
        ti = np.clip((iv[:, 2] + 0.780) / 0.118, 0, 1)
        m.add(iv, if2, np.array([_lerp(THROAT, PLUME, x) for x in ti]),
              1.1 + 1.9 * ti, crease=None)

        # pylon up to the wing underside
        pyv, pyf = M.plate([(0.010, -0.030), (-0.250, -0.030), (-0.250, -0.118),
                            (0.010, -0.118)], 0.020, "v", offset=(nx, 0.0, -0.090))
        pyv, pyf = M.orient_outward(pyv, pyf)
        m.add(pyv, pyf, HULL_DARK, 0.0, crease=None)

        # a trim strip along the nacelle spine so the pod reads as powered
        ns, nsf = M.hull_strip(nprof, np.pi / 2, 0.42, dr=1.06, nseg=4,
                               zrange=(-0.46, 0.02))
        ns, nsf = M.orient_outward(ns, nsf)
        ns = M.transform(ns, translate=(nx, ny, -0.090))
        m.add(ns, nsf, TRIM, 1.5, crease=None)

    # -------------------------------------------------------------- collar rings
    for (z0, z1, r, gl) in ((0.185, 0.060, 0.1395, 1.5), (-0.380, -0.402, 0.1215, 1.2)):
        rv, rf = M.lathe([(z0, r), (z1, r)], SEG)
        rv, rf = M.orient_outward(rv, rf)
        m.add(rv, rf, TRIM, gl, crease=None)

    P, N, C, Gl, F = m.finish()
    P[:, 2] -= (P[:, 2].max() + P[:, 2].min()) * 0.5
    P /= (P[:, 2].max() - P[:, 2].min())
    return P, N, C, Gl, F


def rocket_json(P, N, C, Gl, F):
    return {
        "pos": [round(float(x), 4) for x in P.reshape(-1)],
        "nrm": [round(float(x), 3) for x in N.reshape(-1)],
        "col": [round(float(x), 3) for x in C.reshape(-1)],
        "glow": [round(float(x), 2) for x in Gl.reshape(-1)],
        "idx": [int(i) for i in F.reshape(-1)],
    }

# ==========================================================================
# bake orchestration and cli
# ==========================================================================

# ============================================================ image io
def _save(path, arr, jpeg_quality=86):
    """Write a float array as 8-bit PNG/JPEG.

    Prefers Pillow; falls back to Blender's own image writer so the script still
    works when run as `blender -b --python galaxy_assets.py --` on a box where
    Blender ships its own interpreter without Pillow.
    """
    a = np.clip(np.asarray(arr, np.float32), 0.0, 1.0)
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, -1)
    u8 = (a * 255.0 + 0.5).astype(np.uint8)
    try:
        from PIL import Image
        im = Image.fromarray(u8, "RGBA" if u8.shape[-1] == 4 else "RGB")
        if path.lower().endswith((".jpg", ".jpeg")):
            im.convert("RGB").save(path, quality=jpeg_quality, subsampling=0, optimize=True)
        else:
            im.save(path, optimize=True)
        return
    except ImportError:
        pass
    import bpy  # noqa: F401
    h, w = a.shape[:2]
    img = bpy.data.images.new("out", width=w, height=h, alpha=(a.shape[-1] == 4))
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :a.shape[-1]] = a
    img.pixels = rgba[::-1].reshape(-1).tolist()                  # Blender is bottom-up
    img.file_format = "JPEG" if path.lower().endswith((".jpg", ".jpeg")) else "PNG"
    img.filepath_raw = path
    img.save()


def _downscale(a, fy, fx):
    """Box-average downscale by an integer factor (area-correct, no ringing)."""
    h, w = a.shape[:2]
    h2, w2 = h // fy * fy, w // fx * fx
    b = a[:h2, :w2]
    sh = (h2 // fy, fy, w2 // fx, fx) + a.shape[2:]
    return b.reshape(sh).mean(axis=(1, 3))


# ============================================================ assets
# Three discs, three different structural families rather than three colourways of
# one. They are seen together in the wide shots, so identical structure under
# different accents is read as a repeat; a de Vaucouleurs class each is not.
DISCS = [
    # SB(s)bc: strong boxy bar, grand-design arms off its ends, mild tidal shear
    ("galaxy_nb.png", 20260927, {
        "palette": "cyan", "pitch": 15.0, "arms": 2, "lopsided": 0.13,
        "bar": 1.00, "bar_pa": 0.62, "bar_len": 0.34, "ring": 0.0,
        "tidal": 0.26, "tidal_pa": 2.1, "arm_mix": (1.00, 0.80), "arm_end": (1.00, 0.88)}),
    # SB(r)b: shorter bar inside a bright inner ring, more open arms, nearly symmetric
    ("galaxy_gpu.png", 771, {
        "palette": "amber", "pitch": 19.5, "arms": 2, "lopsided": 0.10,
        "bar": 0.85, "bar_pa": -0.45, "bar_len": 0.29, "ring": 0.18,
        "tidal": 0.12, "tidal_pa": -0.6, "arm_mix": (1.00, 0.86), "arm_end": (1.00, 0.94)}),
    # SABa, interacting: weak bar, tightly wound, strongly tidally distorted, one arm
    # drawn out into a plume and the other truncated
    ("galaxy_edge.png", 4242, {
        "palette": "violet", "pitch": 12.0, "arms": 2, "lopsided": 0.11,
        "bar": 0.42, "bar_pa": 1.95, "bar_len": 0.24, "ring": 0.0,
        "tidal": 0.40, "tidal_pa": 0.85, "arm_mix": (1.00, 0.64), "arm_end": (1.00, 0.76),
        "envelope": 0.090}),
]

PLANETS = [
    # file                   builder   seed
    ("planet_gateway.png", "ice", 8021),
    ("planet_switch.png", "gas", 11),
    ("planet_ap.png", "aurora", 33),
]


def bake_sky(out, size, also=None):
    h = size // 2
    img = build_sky(size, h, seed=20260928, n_stars=int(55000 * (size / 4096.0) ** 2 + 6000),
                    field_div=2)
    # Same cos(lat) longitude band-limit as the planets. The sky sphere has poles too,
    # and the star splats are stretched by 1/cos(lat) with a hard clamp, so within a
    # few degrees of the pole they were being drawn far too narrow -- the top and
    # bottom rows of the plate carried a visible dotted seam.
    img = np.clip(polar_bandlimit(img, keep=1.30, soft=0.30), 0, None)
    img = normalise_sky(img)
    lum = img @ LUMW
    print(f"  sky lum: mean {lum.mean():.4f}  median {np.median(lum):.4f}  p99 {np.percentile(lum, 99):.4f}  p99.9 {np.percentile(lum, 99.9):.4f}  max {lum.max():.4f}  frac>0.78 {100.0 * (lum > 0.78).mean():.4f}%", flush=True)
    # The number that actually matters: this plate is NEVER shown raw. The runtime
    # tints it by 0x333333 on a BackSide sphere and then grades the whole frame with
    # ACES at exposure 1.45, and bloom triggers at 0.78 AFTER that. Measuring the
    # plate alone says nothing about whether the sky will bloom.
    gl = runtime_grade(img * (0x33 / 255.0)) @ LUMW
    print(f"  sky through runtime (tint 0x333333 -> ACES@1.45 -> sat 1.12): "
          f"mean {gl.mean():.4f}  median {np.median(gl):.4f}  p99 {np.percentile(gl, 99):.4f}  "
          f"p99.9 {np.percentile(gl, 99.9):.4f}  max {gl.max():.4f}  "
          f"over bloom 0.78: {int((gl > 0.78).sum())} px ({100.0 * (gl > 0.78).mean():.5f}%)",
          flush=True)
    _save(os.path.join(out, "sky.jpg"), img)
    if also:
        _save(os.path.join(also, "sky.jpg"), img)


def bake_discs(out, size, also=None, also_size=1024):
    for (name, seed, kw) in DISCS:
        k = size / 2048.0
        img, R = build_disc(size, seed=seed, hii_n=int(1300 * k), star_n=int(22000 * k),
                            n_gc=int(170 * min(k, 1.0) ** 0.5), **kw)
        rgb, a = finish_disc(img, R)
        rgba = np.concatenate([rgb, a[..., None]], -1)
        _save(os.path.join(out, name), rgba)
        lum = rgb @ LUMW
        prof = " ".join(f"{a[(r <= R) & (r + 0.1 > R)].mean():.2f}" for r in np.arange(0, 1.0, 0.1))
        print(f"  {name:<17s} lum p50 {np.median(lum):.3f} p99 {np.percentile(lum, 99):.3f}"
              f" | alpha by 0.1R: {prof}", flush=True)
        if also:
            f = max(1, size // also_size)
            _save(os.path.join(also, name), _downscale(rgba, f, f))


def bake_planets(out, size, also=None, also_size=1024):
    w, h = size, size // 2
    for (name, kind, seed) in PLANETS:
        img = bake_aurora_world(w, h, seed) if kind == "aurora" else bake_gas_giant(w, h, seed, kind=kind)
        _save(os.path.join(out, name), img)
        print(f"  {name:<20s} mean {img.mean():.3f}  min {img.min():.3f}  max {img.max():.3f}",
              flush=True)
        if also:
            f = max(1, size // also_size)
            _save(os.path.join(also, name), _downscale(img, f, f))
    sun = bake_star(w, h, seed=5772)
    _save(os.path.join(out, "sun.png"), sun)
    print(f"  {'sun.png':<20s} mean {sun.mean():.3f}  min {sun.min():.3f}  max {sun.max():.3f}",
          flush=True)
    if also:
        f = max(1, size // also_size)
        _save(os.path.join(also, "sun.png"), _downscale(sun, f, f))


def bake_rocket(out, also=None):
    P, N, C, Gl, F = build_rocket()
    obj = rocket_json(P, N, C, Gl, F)
    txt = json.dumps(obj, separators=(",", ":"))
    print(f"  rocket.json  {len(P)} verts  {len(F)} tris  glow max {Gl.max():.1f}"
          f"  bbox {np.round(P.min(0), 3).tolist()}..{np.round(P.max(0), 3).tolist()}", flush=True)
    for d in [out] + ([also] if also else []):
        with open(os.path.join(d, "rocket.json"), "w") as fh:
            fh.write(txt)


# ============================================================ cli
def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="/tmp/galaxy-assets")
    ap.add_argument("--also", default=None,
                    help="second output dir, written at --also-size (repo copies)")
    ap.add_argument("--also-size", type=int, default=1024)
    ap.add_argument("--sky", type=int, default=4096)
    ap.add_argument("--disc", type=int, default=2048)
    ap.add_argument("--planet", type=int, default=2048)
    ap.add_argument("--only", default="sky,discs,planets,rocket")
    return ap.parse_args(argv)


def main():
    a = parse_args()
    only = {s.strip() for s in a.only.split(",") if s.strip()}
    os.makedirs(a.out, exist_ok=True)
    if a.also:
        os.makedirs(a.also, exist_ok=True)
    t0 = time.time()
    if "rocket" in only:
        print("rocket...", flush=True)
        bake_rocket(a.out, a.also)
    if "discs" in only:
        print("discs...", flush=True)
        bake_discs(a.out, a.disc, a.also, a.also_size)
    if "planets" in only:
        print("planets...", flush=True)
        bake_planets(a.out, a.planet, a.also, min(a.also_size, 1024))
    if "sky" in only:
        print("sky...", flush=True)
        bake_sky(a.out, a.sky, a.also)
    print(f"done in {time.time() - t0:.0f}s -> {a.out}", flush=True)


if __name__ == "__main__":
    main()
