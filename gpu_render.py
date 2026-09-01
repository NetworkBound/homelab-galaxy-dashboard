"""Server-side GPU rendering on the RTX 3080 Ti via EGL + moderngl.

Renders an animated 3D scene OFFSCREEN on the GPU and writes a PNG that the
dashboard serves. This genuinely exercises the server GPU (GL_RENDERER reports
the 3080 Ti). The scene's color/displacement is driven by live GPU utilization
so the picture reflects real load.
"""
import os, math, time, threading
os.environ.setdefault("PYOPENGL_PLATFORM", "egl")
import numpy as np
import moderngl
from PIL import Image

W, H = 960, 540
OUT = "/opt/dashboard/static/gpu_scene.png"

_VERT = """
#version 330
uniform mat4 mvp;
uniform float t;
uniform float load;
in vec3 in_pos;
in vec3 in_norm;
out vec3 v_norm;
out float v_h;
void main() {
    vec3 p = in_pos;
    // displace a sphere into an animated, load-reactive surface
    float d = sin(p.x*4.0 + t*1.5)*cos(p.y*4.0 - t)*sin(p.z*4.0 + t*0.7);
    float amp = 0.12 + load*0.55;
    p += in_norm * d * amp;
    v_h = d;
    v_norm = in_norm;
    gl_Position = mvp * vec4(p, 1.0);
}
"""

_FRAG = """
#version 330
in vec3 v_norm;
in float v_h;
uniform float load;
out vec4 f_color;
void main() {
    vec3 L = normalize(vec3(0.6, 0.8, 0.5));
    float diff = max(dot(normalize(v_norm), L), 0.0);
    // hue shifts cyan -> magenta with load
    vec3 cool = vec3(0.10, 0.85, 1.00);
    vec3 hot  = vec3(1.00, 0.25, 0.65);
    vec3 base = mix(cool, hot, clamp(load + v_h*0.5, 0.0, 1.0));
    vec3 col = base * (0.25 + 0.9*diff) + vec3(0.04,0.06,0.10);
    f_color = vec4(col, 1.0);
}
"""

def _icosphere(subdiv=4):
    t = (1.0 + 5 ** 0.5) / 2.0
    verts = [(-1,t,0),(1,t,0),(-1,-t,0),(1,-t,0),(0,-1,t),(0,1,t),
             (0,-1,-t),(0,1,-t),(t,0,-1),(t,0,1),(-t,0,-1),(-t,0,1)]
    verts = [np.array(v, dtype="f4") for v in verts]
    verts = [v/np.linalg.norm(v) for v in verts]
    faces = [(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),
             (11,10,2),(10,7,6),(7,1,8),(3,9,4),(3,4,2),(3,2,6),(3,6,8),
             (3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]
    cache = {}
    def mid(a, b):
        key = (min(a,b), max(a,b))
        if key in cache: return cache[key]
        m = (verts[a] + verts[b]); m = m/np.linalg.norm(m)
        verts.append(m); cache[key] = len(verts)-1
        return cache[key]
    for _ in range(subdiv):
        nf = []
        for a,b,c in faces:
            ab,bc,ca = mid(a,b),mid(b,c),mid(c,a)
            nf += [(a,ab,ca),(b,bc,ab),(c,ca,bc),(ab,bc,ca)]
        faces = nf
    data = []
    for a,b,c in faces:
        for i in (a,b,c):
            v = verts[i]
            data += [v[0],v[1],v[2], v[0],v[1],v[2]]  # pos + normal (unit sphere)
    return np.array(data, dtype="f4")

def _persp(fovy, aspect, n, f):
    fy = 1.0/math.tan(fovy/2)
    return np.array([[fy/aspect,0,0,0],[0,fy,0,0],
                     [0,0,(f+n)/(n-f),(2*f*n)/(n-f)],[0,0,-1,0]], dtype="f4")

def _look(eye, tgt, up):
    f = (tgt-eye); f/=np.linalg.norm(f)
    s = np.cross(f,up); s/=np.linalg.norm(s)
    u = np.cross(s,f)
    m = np.eye(4, dtype="f4")
    m[0,:3]=s; m[1,:3]=u; m[2,:3]=-f
    m[0,3]=-s.dot(eye); m[1,3]=-u.dot(eye); m[2,3]=f.dot(eye)
    return m

class Renderer:
    def __init__(self):
        self.ctx = moderngl.create_context(standalone=True, backend="egl", require=330)
        self.renderer = self.ctx.info["GL_RENDERER"]
        self.prog = self.ctx.program(vertex_shader=_VERT, fragment_shader=_FRAG)
        verts = _icosphere(4)
        self.vbo = self.ctx.buffer(verts.tobytes())
        self.vao = self.ctx.vertex_array(self.prog, [(self.vbo, "3f 3f", "in_pos", "in_norm")])
        self.fbo = self.ctx.framebuffer(
            color_attachments=[self.ctx.texture((W, H), 4)],
            depth_attachment=self.ctx.depth_renderbuffer((W, H)))
        self.ctx.enable(moderngl.DEPTH_TEST)
        os.makedirs(os.path.dirname(OUT), exist_ok=True)

    def frame(self, load):
        t = time.time()
        self.fbo.use()
        self.ctx.clear(0.02, 0.03, 0.07, 1.0)
        ang = t * 0.5
        eye = np.array([math.cos(ang)*3.2, 1.3, math.sin(ang)*3.2], dtype="f4")
        mvp = _persp(math.radians(45), W/H, 0.1, 100) @ _look(eye, np.zeros(3,"f4"), np.array([0,1,0],"f4"))
        self.prog["mvp"].write(mvp.T.astype("f4").tobytes())
        self.prog["t"].value = t
        self.prog["load"].value = float(load)
        self.vao.render()
        data = self.fbo.read(components=3)
        img = Image.frombytes("RGB", (W, H), data).transpose(Image.FLIP_TOP_BOTTOM)
        tmp = OUT + ".tmp"
        img.save(tmp, format="PNG"); os.replace(tmp, OUT)

_renderer = None
def loop(get_load):
    global _renderer
    _renderer = Renderer()
    print("[gpu_render] GL_RENDERER =", _renderer.renderer, flush=True)
    while True:
        try:
            _renderer.frame(get_load())
        except Exception as e:
            print("[gpu_render] err", e, flush=True)
        time.sleep(0.1)  # ~10 fps server-side GPU render

def start(get_load):
    threading.Thread(target=loop, args=(get_load,), daemon=True).start()
