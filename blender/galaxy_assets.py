"""galaxy_assets.py - bake the galaxy dashboard's universe textures with Blender (headless).

    blender -b --python galaxy_assets.py -- --out DIR [--sky 4096] [--disc 2048] [--planet 1024] [--only sky,discs,planets,rocket]

Outputs (all procedural, deterministic, no external models):
  sky.jpg                 equirectangular nebula sky (Cycles world-only render, no geometry):
                          deep space with cyan / violet / amber nebula veils, luminance kept low
                          (< ~0.35) so the dashboards' bloom threshold never catches the backdrop.
  galaxy_gpu.png          face-on spiral galaxy discs, RGBA, tinted per node - two log arms,
  galaxy_nb.png           dust lanes, HII knots, hot core. Used as billboards UNDER the live
  galaxy_edge.png         point-star arms on both screens (1 draw call each).
  planet_gateway.png      equirect (2:1) seamless procedural surfaces (banded gas giants /
  planet_switch.png       aurora world), keyed to the fabric colours the scenes already use.
  planet_ap.png
  sun.png                 equirect granulated stellar surface (Voronoi cells + noise).
  rocket.json             the brand rocket as a compact vertex-coloured triangle
                          list {pos, col, glow, idx} for THREE.BufferGeometry (no loader).

Same visual language as the project's Discord brand renders (a separate
repo), so the room, the server and the videos read as one brand.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bmesh
import bpy

CYAN = (0.13, 0.76, 1.0)
VIOLET = (0.49, 0.36, 1.0)
AMBER = (1.0, 0.70, 0.28)
ORANGE_CF = (0.96, 0.51, 0.12)
WHITE = (0.94, 0.97, 1.0)
FLAME = (1.0, 0.55, 0.12)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/galaxy-assets")
    ap.add_argument("--sky", type=int, default=4096)
    ap.add_argument("--disc", type=int, default=2048)
    ap.add_argument("--planet", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--only", default="sky,discs,planets,rocket")
    return ap.parse_args(argv)


# ---------------------------------------------------------------- helpers

def reset_scene(engine: str, w: int, h: int, transparent: bool, samples: int) -> bpy.types.Scene:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = transparent
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    sc.render.image_settings.color_depth = "8"
    # keep colours as authored: Standard view transform, no filmic curve, so the
    # emissive values map 1:1 onto the texture and the runtime bloom stays predictable
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    if engine == "cycles":
        sc.render.engine = "CYCLES"
        sc.cycles.samples = samples
        sc.cycles.use_denoising = False
        sc.cycles.device = "CPU"
        sc.cycles.max_bounces = 0
    else:
        try:
            sc.render.engine = "BLENDER_EEVEE_NEXT"
        except TypeError:
            sc.render.engine = "BLENDER_EEVEE"
        sc.eevee.taa_render_samples = max(8, samples)
    return sc


def world_black(sc: bpy.types.Scene) -> None:
    w = bpy.data.worlds.new("black")
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0, 0, 0, 1)
    bg.inputs["Strength"].default_value = 0.0


def ortho_cam(sc: bpy.types.Scene, size: float, z: float = 10.0, aspect_w: float = 1.0) -> bpy.types.Object:
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = size
    cam.location = (0, 0, z)
    cam.rotation_euler = (0, 0, 0)
    bpy.context.collection.objects.link(cam)
    sc.camera = cam
    return cam


def N(nt, kind: str, **props):
    n = nt.nodes.new(kind)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def math_node(nt, op: str, a=None, b=None, c=None):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def render_to(sc: bpy.types.Scene, path: str) -> None:
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("wrote", path, flush=True)


# ---------------------------------------------------------------- sky

def bake_sky(out: str, size: int, samples: int) -> None:
    """World-only Cycles render through an equirectangular panoramic camera."""
    sc = reset_scene("cycles", size, size // 2, False, max(8, samples // 2))
    sc.render.image_settings.file_format = "JPEG"
    sc.render.image_settings.quality = 92
    sc.render.image_settings.color_mode = "RGB"
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "PANO"
    try:
        cam.data.panorama_type = "EQUIRECTANGULAR"
    except AttributeError:   # Blender < 4: the setting lives on cycles' camera props
        cam.data.cycles.panorama_type = "EQUIRECTANGULAR"
    cam.location = (0, 0, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    bpy.context.collection.objects.link(cam)
    sc.camera = cam

    w = bpy.data.worlds.new("nebula")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    L = nt.links.new
    out_n = N(nt, "ShaderNodeOutputWorld")
    tex = N(nt, "ShaderNodeTexCoord")
    # direction vector -> three noise fields at different scales; each veil is a
    # thresholded, softened band so the sky is mostly black with a few luminous regions
    def veil(scale: float, detail: float, lo: float, hi: float, offset):
        m = N(nt, "ShaderNodeMapping")
        m.inputs["Location"].default_value = offset
        m.inputs["Scale"].default_value = (scale, scale, scale)
        L(tex.outputs["Generated"], m.inputs["Vector"])
        nz = N(nt, "ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 1.0
        nz.inputs["Detail"].default_value = detail
        nz.inputs["Roughness"].default_value = 0.62
        L(m.outputs["Vector"], nz.inputs["Vector"])
        r = N(nt, "ShaderNodeMapRange")
        r.inputs["From Min"].default_value = lo
        r.inputs["From Max"].default_value = hi
        r.clamp = True
        L(nz.outputs["Fac"], r.inputs["Value"])
        p = math_node(nt, "POWER", r.outputs["Result"], 2.2)
        return p

    # large-scale veils (three colours) + a faint fine dust field
    v1 = veil(1.6, 6.0, 0.52, 0.80, (0.0, 0.0, 0.0))     # cyan
    v2 = veil(1.9, 7.0, 0.55, 0.82, (3.1, 1.7, 0.4))     # violet
    v3 = veil(2.3, 6.0, 0.57, 0.84, (7.3, 4.2, 2.9))     # amber
    v4 = veil(5.0, 8.0, 0.50, 0.85, (11.0, 9.0, 5.0))    # fine dust, neutral
    # a broad dark lane so the sky is not uniformly busy (multiplies everything)
    lane = veil(0.8, 3.0, 0.30, 0.75, (20.0, 3.0, 8.0))

    def col(rgb, strength):
        c = N(nt, "ShaderNodeRGB")
        c.outputs[0].default_value = (rgb[0] * strength, rgb[1] * strength, rgb[2] * strength, 1)
        return c.outputs[0]

    def scaled(colour_out, fac_out):
        mix = N(nt, "ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        L(colour_out, mix.inputs[6])
        # fac -> RGB via a second RGB mix (black -> white)
        f = N(nt, "ShaderNodeMix")
        f.data_type = "RGBA"
        f.blend_type = "MIX"
        f.inputs[6].default_value = (0, 0, 0, 1)
        f.inputs[7].default_value = (1, 1, 1, 1)
        L(fac_out, f.inputs["Factor"])
        L(f.outputs[2], mix.inputs[7])
        return mix.outputs[2]

    def add(a, b):
        mix = N(nt, "ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "ADD"
        mix.inputs["Factor"].default_value = 1.0
        L(a, mix.inputs[6])
        L(b, mix.inputs[7])
        return mix.outputs[2]

    s = add(add(scaled(col(CYAN, 0.30), v1), scaled(col(VIOLET, 0.28), v2)),
            add(scaled(col(AMBER, 0.20), v3), scaled(col((0.55, 0.62, 0.80), 0.12), v4)))
    # dark lane multiply (0.35..1)
    lane_r = N(nt, "ShaderNodeMapRange")
    lane_r.inputs["From Min"].default_value = 0.0
    lane_r.inputs["From Max"].default_value = 1.0
    lane_r.inputs["To Min"].default_value = 1.0
    lane_r.inputs["To Max"].default_value = 0.35
    L(lane, lane_r.inputs["Value"])
    s = scaled(s, lane_r.outputs["Result"])
    # floor: a very deep blue-black so the sky is never pure 0 (banding on video)
    s = add(s, col((0.010, 0.016, 0.034), 1.0))
    bg = N(nt, "ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 1.0
    L(s, bg.inputs["Color"])
    L(bg.outputs[0], out_n.inputs["Surface"])
    render_to(sc, os.path.join(out, "sky.jpg"))


# ---------------------------------------------------------------- galaxy discs

def galaxy_material(name: str, accent, hot, arms: int, wind: float, seed_offset: float) -> bpy.types.Material:
    """Face-on spiral: fac = arms shaped by noise, radial falloff, hot core; alpha = fac.
    Black between the arms and fully transparent outside ~0.9 R - the runtime point-stars
    sit on top, so this texture must carry STRUCTURE (arms, lanes, core), never a fill."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.blend_method = "BLEND"
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    L = nt.links.new
    out = N(nt, "ShaderNodeOutputMaterial")
    tex = N(nt, "ShaderNodeTexCoord")
    mp = N(nt, "ShaderNodeMapping")
    L(tex.outputs["Object"], mp.inputs["Vector"])          # plane spans -1..1 (size 2)
    sep = N(nt, "ShaderNodeSeparateXYZ")
    L(mp.outputs["Vector"], sep.inputs["Vector"])
    x, y = sep.outputs["X"], sep.outputs["Y"]
    r = math_node(nt, "SQRT", math_node(nt, "ADD", math_node(nt, "MULTIPLY", x, x), math_node(nt, "MULTIPLY", y, y)))
    theta = math_node(nt, "ARCTAN2", y, x)
    # logarithmic winding: theta_arm = k * ln(r); arms sharpen with a high power
    lnr = math_node(nt, "LOGARITHM", math_node(nt, "MAXIMUM", r, 0.02), math.e)
    phase = math_node(nt, "ADD", math_node(nt, "MULTIPLY", theta, float(arms)), math_node(nt, "MULTIPLY", lnr, wind))
    arm = math_node(nt, "MULTIPLY_ADD", math_node(nt, "SINE", phase), 0.5, 0.5)
    arm = math_node(nt, "POWER", arm, 2.6)
    # a much fainter inter-arm disc (real galaxies are not black between arms) - 8%
    arm = math_node(nt, "MULTIPLY_ADD", arm, 0.92, 0.08)
    # radial falloff: exponential-ish, and a hard soft-edge at 0.9 R
    fall = math_node(nt, "POWER", math_node(nt, "SUBTRACT", 1.0, math_node(nt, "MINIMUM", r, 1.0)), 1.25)
    edge_t = N(nt, "ShaderNodeMapRange"); edge_t.inputs["From Min"].default_value = 0.92; edge_t.inputs["From Max"].default_value = 0.70
    edge_t.inputs["To Min"].default_value = 0.0; edge_t.inputs["To Max"].default_value = 1.0; edge_t.clamp = True
    L(r, edge_t.inputs["Value"])
    fall = math_node(nt, "MULTIPLY", fall, math_node(nt, "POWER", edge_t.outputs["Result"], 1.5))
    # noise: clumpy structure along the arms + dark dust lanes
    nz = N(nt, "ShaderNodeTexNoise")
    nz.noise_dimensions = "4D"
    nz.inputs["Scale"].default_value = 9.0
    nz.inputs["Detail"].default_value = 10.0
    nz.inputs["Roughness"].default_value = 0.66
    nz.inputs["W"].default_value = seed_offset
    L(mp.outputs["Vector"], nz.inputs["Vector"])
    clamp1 = N(nt, "ShaderNodeClamp")
    L(math_node(nt, "POWER", math_node(nt, "MULTIPLY_ADD", nz.outputs["Fac"], 1.9, -0.55), 1.3), clamp1.inputs["Value"])
    dust = N(nt, "ShaderNodeTexNoise")
    dust.noise_dimensions = "4D"
    dust.inputs["Scale"].default_value = 5.0
    dust.inputs["Detail"].default_value = 7.0
    dust.inputs["W"].default_value = seed_offset + 7.0
    L(mp.outputs["Vector"], dust.inputs["Vector"])
    lane = math_node(nt, "SUBTRACT", 1.0, math_node(nt, "MULTIPLY", math_node(nt, "POWER", math_node(nt, "MULTIPLY_ADD", dust.outputs["Fac"], 2.4, -1.0), 2.0), 0.9))
    lane_c = N(nt, "ShaderNodeClamp"); L(lane, lane_c.inputs["Value"])
    arms_fac = math_node(nt, "MULTIPLY", math_node(nt, "MULTIPLY", arm, fall), math_node(nt, "MULTIPLY", clamp1.outputs[0], lane_c.outputs[0]))
    # core bulge: bright, compact
    core = math_node(nt, "POWER", math_node(nt, "SUBTRACT", 1.0, math_node(nt, "MINIMUM", math_node(nt, "MULTIPLY", r, 4.5), 1.0)), 2.0)
    halo = math_node(nt, "MULTIPLY", math_node(nt, "POWER", math_node(nt, "SUBTRACT", 1.0, math_node(nt, "MINIMUM", math_node(nt, "MULTIPLY", r, 1.25), 1.0)), 2.2), 0.16)
    total = math_node(nt, "ADD", math_node(nt, "ADD", math_node(nt, "MULTIPLY", arms_fac, 4.0), core), halo)
    fac = N(nt, "ShaderNodeClamp"); L(total, fac.inputs["Value"])
    # colour: dim accent between arms -> accent on the arms -> hot at the core
    ramp = N(nt, "ShaderNodeValToRGB")
    e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (accent[0] * 0.35, accent[1] * 0.35, accent[2] * 0.35, 1)
    e[1].position = 1.0; e[1].color = (hot[0], hot[1], hot[2], 1)
    mid = ramp.color_ramp.elements.new(0.45); mid.color = (accent[0], accent[1], accent[2], 1)
    L(fac.outputs[0], ramp.inputs["Fac"])
    knots = N(nt, "ShaderNodeTexNoise")
    knots.noise_dimensions = "4D"
    knots.inputs["Scale"].default_value = 28.0
    knots.inputs["Detail"].default_value = 3.0
    knots.inputs["W"].default_value = seed_offset + 13.0
    L(mp.outputs["Vector"], knots.inputs["Vector"])
    kfac = N(nt, "ShaderNodeClamp")
    L(math_node(nt, "MULTIPLY", math_node(nt, "MULTIPLY_ADD", knots.outputs["Fac"], 7.0, -4.6), math_node(nt, "MULTIPLY", arms_fac, 3.0)), kfac.inputs["Value"])
    kmix = N(nt, "ShaderNodeMix"); kmix.data_type = "RGBA"; kmix.blend_type = "MIX"
    L(ramp.outputs["Color"], kmix.inputs[6])
    kmix.inputs[7].default_value = (1.0, 0.55, 0.75, 1)
    L(kfac.outputs[0], kmix.inputs["Factor"])
    em = N(nt, "ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.0
    L(kmix.outputs[2], em.inputs["Color"])
    trans = N(nt, "ShaderNodeBsdfTransparent")
    mix = N(nt, "ShaderNodeMixShader")
    L(fac.outputs[0], mix.inputs["Fac"])
    L(trans.outputs[0], mix.inputs[1])
    L(em.outputs[0], mix.inputs[2])
    L(mix.outputs[0], out.inputs[0])
    return m


def bake_discs(out: str, size: int, samples: int) -> None:
    specs = [
        ("galaxy_gpu.png", CYAN, (0.92, 0.98, 1.0), 2, 3.0, 1.0),
        ("galaxy_nb.png", AMBER, (1.0, 0.94, 0.80), 2, 2.6, 5.0),
        ("galaxy_edge.png", (0.72, 0.42, 0.95), (1.0, 0.80, 0.55), 3, 2.2, 9.0),   # violet arms, cloudflare-orange core
    ]
    for fname, accent, hot, arms, wind, seed in specs:
        sc = reset_scene("eevee", size, size, True, samples)
        world_black(sc)
        ortho_cam(sc, 2.0)
        bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0, 0, 0))
        plane = bpy.context.active_object
        plane.data.materials.append(galaxy_material(fname, accent, hot, arms, wind, seed))
        render_to(sc, os.path.join(out, fname))


# ---------------------------------------------------------------- planets + sun

def seamless_vector(nt, tex_out, twist: float = 0.0):
    """Map the 2:1 plane's UV onto a cylinder so noise wraps seamlessly at u=0/1."""
    L = nt.links.new
    sep = N(nt, "ShaderNodeSeparateXYZ")
    L(tex_out, sep.inputs["Vector"])
    u = math_node(nt, "MULTIPLY", sep.outputs["X"], 2 * math.pi)
    v = sep.outputs["Y"]
    if twist:
        u = math_node(nt, "ADD", u, math_node(nt, "MULTIPLY", v, twist))
    comb = N(nt, "ShaderNodeCombineXYZ")
    L(math_node(nt, "COSINE", u), comb.inputs["X"])
    L(math_node(nt, "SINE", u), comb.inputs["Y"])
    L(math_node(nt, "MULTIPLY", v, 2.6), comb.inputs["Z"])
    return comb.outputs["Vector"], v


def planet_material(name: str, base, band, hot, kind: str, seed: float) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    L = nt.links.new
    out = N(nt, "ShaderNodeOutputMaterial")
    tex = N(nt, "ShaderNodeTexCoord")
    vec, v = seamless_vector(nt, tex.outputs["UV"], twist=0.6 if kind == "gas" else 0.0)
    # latitude bands: sin(v * k) warped by low-frequency noise
    warp = N(nt, "ShaderNodeTexNoise")
    warp.inputs["Scale"].default_value = 1.6
    warp.inputs["Detail"].default_value = 4.0
    warp.noise_dimensions = "4D"
    warp.inputs["W"].default_value = seed
    L(vec, warp.inputs["Vector"])
    lat = math_node(nt, "ADD", math_node(nt, "MULTIPLY", v, 22.0 if kind == "gas" else 9.0), math_node(nt, "MULTIPLY", warp.outputs["Fac"], 5.5 if kind == "gas" else 3.0))
    bands = math_node(nt, "MULTIPLY_ADD", math_node(nt, "SINE", lat), 0.5, 0.5)
    fine = N(nt, "ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 6.0
    fine.inputs["Detail"].default_value = 9.0
    fine.inputs["Roughness"].default_value = 0.6
    fine.noise_dimensions = "4D"
    fine.inputs["W"].default_value = seed + 3.0
    L(vec, fine.inputs["Vector"])
    if kind == "gas":
        fac = math_node(nt, "MULTIPLY_ADD", bands, 0.75, math_node(nt, "MULTIPLY", fine.outputs["Fac"], 0.35))
    else:   # aurora / storm world: swirling cells with bright filaments
        vor = N(nt, "ShaderNodeTexVoronoi")
        vor.inputs["Scale"].default_value = 5.0
        vor.feature = "DISTANCE_TO_EDGE"
        L(vec, vor.inputs["Vector"])
        fil = math_node(nt, "POWER", math_node(nt, "SUBTRACT", 1.0, math_node(nt, "MINIMUM", math_node(nt, "MULTIPLY", vor.outputs["Distance"], 6.0), 1.0)), 3.0)
        fac = math_node(nt, "ADD", math_node(nt, "MULTIPLY", math_node(nt, "MULTIPLY_ADD", bands, 0.4, math_node(nt, "MULTIPLY", fine.outputs["Fac"], 0.6)), 0.8), math_node(nt, "MULTIPLY", fil, 0.9))
    facc = N(nt, "ShaderNodeClamp"); L(fac, facc.inputs["Value"])
    ramp = N(nt, "ShaderNodeValToRGB")
    e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (base[0], base[1], base[2], 1)
    e[1].position = 1.0; e[1].color = (hot[0], hot[1], hot[2], 1)
    mid = ramp.color_ramp.elements.new(0.55); mid.color = (band[0], band[1], band[2], 1)
    L(facc.outputs[0], ramp.inputs["Fac"])
    # polar darkening so the sphere reads as lit from the equator outward
    pole = math_node(nt, "SUBTRACT", 1.0, math_node(nt, "MULTIPLY", math_node(nt, "POWER", math_node(nt, "ABSOLUTE", math_node(nt, "MULTIPLY_ADD", v, 2.0, -1.0)), 3.0), 0.55))
    dark = N(nt, "ShaderNodeMix"); dark.data_type = "RGBA"; dark.blend_type = "MULTIPLY"; dark.inputs["Factor"].default_value = 1.0
    L(ramp.outputs["Color"], dark.inputs[6])
    pm = N(nt, "ShaderNodeMix"); pm.data_type = "RGBA"; pm.blend_type = "MIX"
    pm.inputs[6].default_value = (0, 0, 0, 1); pm.inputs[7].default_value = (1, 1, 1, 1)
    L(pole, pm.inputs["Factor"]); L(pm.outputs[2], dark.inputs[7])
    em = N(nt, "ShaderNodeEmission"); em.inputs["Strength"].default_value = 1.0
    L(dark.outputs[2], em.inputs["Color"])
    L(em.outputs[0], out.inputs[0])
    return m


def sun_material(name: str, seed: float) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    L = nt.links.new
    out = N(nt, "ShaderNodeOutputMaterial")
    tex = N(nt, "ShaderNodeTexCoord")
    vec, v = seamless_vector(nt, tex.outputs["UV"])
    vor = N(nt, "ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 14.0
    vor.feature = "DISTANCE_TO_EDGE"
    L(vec, vor.inputs["Vector"])
    cells = math_node(nt, "POWER", math_node(nt, "MINIMUM", math_node(nt, "MULTIPLY", vor.outputs["Distance"], 16.0), 1.0), 0.45)
    nz = N(nt, "ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 5.0
    nz.inputs["Detail"].default_value = 8.0
    nz.noise_dimensions = "4D"
    nz.inputs["W"].default_value = seed
    L(vec, nz.inputs["Vector"])
    fac = math_node(nt, "MULTIPLY", math_node(nt, "MULTIPLY_ADD", cells, 0.6, 0.25), math_node(nt, "MULTIPLY_ADD", nz.outputs["Fac"], 1.3, 0.1))
    facc = N(nt, "ShaderNodeClamp"); L(fac, facc.inputs["Value"])
    ramp = N(nt, "ShaderNodeValToRGB")
    e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (0.55, 0.12, 0.0, 1)
    e[1].position = 1.0; e[1].color = (1.0, 0.96, 0.78, 1)
    mid = ramp.color_ramp.elements.new(0.5); mid.color = (1.0, 0.55, 0.08, 1)
    L(facc.outputs[0], ramp.inputs["Fac"])
    em = N(nt, "ShaderNodeEmission"); em.inputs["Strength"].default_value = 1.0
    L(ramp.outputs["Color"], em.inputs["Color"])
    L(em.outputs[0], out.inputs[0])
    return m


def bake_planets(out: str, size: int, samples: int) -> None:
    specs = [
        ("planet_gateway.png", (0.05, 0.22, 0.40), (0.20, 0.62, 0.90), (0.80, 0.97, 1.0), "gas", 1.0),
        ("planet_switch.png", (0.35, 0.16, 0.04), (0.85, 0.52, 0.16), (1.0, 0.86, 0.55), "gas", 5.0),
        ("planet_ap.png", (0.03, 0.22, 0.16), (0.12, 0.70, 0.45), (0.65, 1.0, 0.80), "aurora", 9.0),
    ]
    for fname, base, band, hot, kind, seed in specs:
        sc = reset_scene("eevee", size, size // 2, False, samples)
        world_black(sc)
        ortho_cam(sc, 2.0)
        bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0, 0, 0))
        plane = bpy.context.active_object
        plane.scale = (2.0, 1.0, 1.0)
        plane.data.materials.append(planet_material(fname, base, band, hot, kind, seed))
        render_to(sc, os.path.join(out, fname))
    sc = reset_scene("eevee", size, size // 2, False, samples)
    world_black(sc)
    ortho_cam(sc, 2.0)
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0, 0, 0))
    plane = bpy.context.active_object
    plane.scale = (2.0, 1.0, 1.0)
    plane.data.materials.append(sun_material("sun", 2.0))
    render_to(sc, os.path.join(out, "sun.png"))


# ---------------------------------------------------------------- rocket

def rocket_parts():
    """(object, rgb, glow) for the Discord rocket, low-poly. glow>0 = emissive part."""
    hull = (0.80, 0.86, 0.95)
    dark = (0.06, 0.08, 0.12)
    parts = []

    def add(fn, rgb, glow, **kw):
        fn(**kw)
        o = bpy.context.active_object
        parts.append((o, rgb, glow))
        return o

    add(bpy.ops.mesh.primitive_cylinder_add, hull, 0.0, vertices=20, radius=0.42, depth=2.6, location=(0, 0, 0))
    add(bpy.ops.mesh.primitive_cone_add, hull, 0.0, vertices=20, radius1=0.42, radius2=0.02, depth=1.1, location=(0, 0, 1.85))
    add(bpy.ops.mesh.primitive_torus_add, CYAN, 2.5, major_radius=0.43, minor_radius=0.035, location=(0, 0, 0.9), major_segments=24, minor_segments=6)
    add(bpy.ops.mesh.primitive_torus_add, VIOLET, 2.0, major_radius=0.43, minor_radius=0.03, location=(0, 0, -0.9), major_segments=24, minor_segments=6)
    add(bpy.ops.mesh.primitive_uv_sphere_add, CYAN, 2.5, radius=0.14, location=(0.36, 0, 0.35), segments=12, ring_count=8)
    add(bpy.ops.mesh.primitive_cone_add, dark, 0.0, vertices=20, radius1=0.30, radius2=0.42, depth=0.45, location=(0, 0, -1.5))
    for i in range(4):
        ang = math.radians(90 * i + 45)
        fin = add(bpy.ops.mesh.primitive_cube_add, hull, 0.0, size=1.0, location=(0.62 * math.cos(ang), 0.62 * math.sin(ang), -1.0))
        fin.scale = (0.5, 0.05, 0.55)
        fin.rotation_euler = (0, math.radians(-25), ang)
        edge = add(bpy.ops.mesh.primitive_cube_add, VIOLET, 1.6, size=1.0, location=(0.78 * math.cos(ang), 0.78 * math.sin(ang), -1.05))
        edge.scale = (0.12, 0.02, 0.45)
        edge.rotation_euler = (0, math.radians(-25), ang)
    core = add(bpy.ops.mesh.primitive_cone_add, (1.0, 0.95, 0.8), 3.5, vertices=16, radius1=0.22, radius2=0.0, depth=1.6, location=(0, 0, -2.5))
    core.rotation_euler = (math.pi, 0, 0)
    flame = add(bpy.ops.mesh.primitive_cone_add, FLAME, 2.2, vertices=16, radius1=0.34, radius2=0.0, depth=2.4, location=(0, 0, -2.9))
    flame.rotation_euler = (math.pi, 0, 0)
    return parts


def bake_rocket(out: str) -> None:
    reset_scene("eevee", 64, 64, False, 8)
    parts = rocket_parts()
    bpy.context.view_layer.update()
    pos, col, glow, idx, nrm = [], [], [], [], []
    base = 0
    for o, rgb, g in parts:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.verts.ensure_lookup_table()
        M = o.matrix_world
        Mn = M.to_3x3().inverted().transposed()
        for vtx in bm.verts:
            p = M @ vtx.co
            n = (Mn @ vtx.normal).normalized()
            pos += [round(p.x, 4), round(p.y, 4), round(p.z, 4)]
            nrm += [round(n.x, 3), round(n.y, 3), round(n.z, 3)]
            col += [round(rgb[0], 3), round(rgb[1], 3), round(rgb[2], 3)]
            glow.append(g)
        for f in bm.faces:
            idx += [base + v.index for v in f.verts]
        base += len(bm.verts)
        bm.free()
    data = {"pos": pos, "nrm": nrm, "col": col, "glow": glow, "idx": idx,
            "note": "brand rocket, +Z = nose, exhaust at -Z; glow>0 marks emissive parts (multiply colour by 1+glow for bloom)"}
    path = os.path.join(out, "rocket.json")
    with open(path, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    print("wrote", path, len(pos) // 3, "verts", len(idx) // 3, "tris", flush=True)


# ---------------------------------------------------------------- main

if __name__ == "__main__":
    a = parse_args()
    os.makedirs(a.out, exist_ok=True)
    only = set(a.only.split(","))
    if "rocket" in only:
        bake_rocket(a.out)
    if "discs" in only:
        bake_discs(a.out, a.disc, a.samples)
    if "planets" in only:
        bake_planets(a.out, a.planet, a.samples)
    if "sky" in only:
        bake_sky(a.out, a.sky, a.samples)
    print("DONE", flush=True)
