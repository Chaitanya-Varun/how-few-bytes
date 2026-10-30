# The laptop's models for the game, run next to server/local.js:
#   - FlexTok: encodes a photo into 256 tokens and decodes the first 1, 2, 4, ..., 256 of them
#     (2 to 512 bytes), the nine rungs of the game's ladder (Camera rounds).
#   - FlexAR-1B-C2I: writes the 256 tokens itself from an ImageNet class (Imagine rounds).
#   - CLIP ViT-L/14: judges typed guesses by meaning against the picture.
# Same FlexTok model as the proposal's figures (make_mockups.py), with 8 denoising steps
# instead of 25.
#
# Speed on an M5 Pro (time is linear in forward passes): 4.3 s per rung with guidance 7.5,
# 2.2 s without. Guidance only matters at the shortest prefixes (at 1-4 tokens the unguided
# picture loses the subject; from 8 tokens up the two look the same), so it runs only up to
# --guidance-until tokens: a full ladder takes ~26 s instead of ~39 s. Lower precision doesn't
# help on MPS: no FP8 support, fp16/bf16 weights trip a Metal matmul dtype assertion, and
# autocast is slower than fp32. Fewer steps blur the low rungs the game is played on.
# Prefixes are decoded one at a time: with the dense attention MPS needs, a batch of 3 is
# slower than 3 singles.
#
# FlexAR has no KV cache, so generating 256 tokens takes ~37 s (16 take 0.6 s, 64 take 3.4 s).
# Generation starts as soon as the photographer picks a class (/imagine/start), in chunks so
# rung decodes can cut in: decodes always get the GPU before background generation.
#
# Rungs stream out coarse to fine as each finishes (one JSON line per rung) and the game shows
# each rung for 5 s, so decoding stays ahead of the reveal.
#
# Run in the research environment:
#   HF_HUB_OFFLINE=1 ~/miniforge3/envs/IF_py3p11/bin/python decoder/flextok_server.py
#
#   GET  /health          -> {"ready": bool, "flexar": bool, "clip": bool, ...}
#   POST /ladder          body: JPEG/PNG bytes -> one line per rung, in order:
#                         {"rung": i, "image": base64 JPEG, "seconds": since the request}
#   POST /imagine/start   {"label": 0-999, "replaces": job id?} -> {"job": id}
#   POST /imagine/ladder  {"job": id} -> rungs, like /ladder
#   POST /judge           {"image": base64, "answers": [...], "guess": str}
#                         -> {"verdict": "match" | "warm" | "miss", "margin": float, "text": float}
import argparse, base64, collections, contextlib, hashlib, io, json, os, random, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image, ImageOps

RESEARCH = "/Users/chsa4987/Library/CloudStorage/OneDrive-UCB-O365/Desktop/FlexTok/Improving-FlexTok"
TOKENS = [1, 2, 4, 8, 16, 32, 64, 128, 256]
AR_CHUNKS = [1, 2, 4, 8, 16] + list(range(24, 257, 8))  # generation pauses for decodes between these
MAX_BODY = 8 * 1024 * 1024
JOB_TTL = 600

# Judging thresholds, tuned on ~100 guess/answer pairs over FlexAR pictures of 10 classes.
# margin = sim(picture, guess) - max over answers of sim(picture, answer), in CLIP cosine units
MATCH_MARGIN = -0.035  # the guess describes the picture about as well as the answer does
TEXT_FLOOR = 0.6  # and is at least loosely related to an answer as text
WARM_MARGIN = -0.045  # near miss: "Close!"
# Category words CLIP rates close to almost anything in them; never auto-accepted
GENERIC = set("""animal pet mammal creature beast bird insect bug fish food meal dish snack fruit vegetable drink
plant flower tree vehicle machine device electronics gadget tool instrument object thing stuff item container
kitchenware furniture clothing toy building aquarium nature picture photo image""".split())

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8799)
ap.add_argument("--steps", type=int, default=int(os.environ.get("DECODE_STEPS", 8)), help="denoising steps per decode")
ap.add_argument("--guidance", type=float, default=7.5)
ap.add_argument("--guidance-until", type=int, default=4, help="apply guidance only to prefixes up to this many tokens")
ap.add_argument("--model", default="EPFL-VILAB/flextok_d18_d28_in1k")
ap.add_argument("--decoder-weights", default=None, help="optional state_dict for model.decoder (e.g. a fine-tuned decoder)")
ap.add_argument("--ar-model", default="EPFL-VILAB/FlexAR-1B-C2I")
ap.add_argument("--ar-cfg", type=float, default=1.5, help="FlexAR classifier-free guidance (its config's default)")
ap.add_argument("--clip-model", default="openai/clip-vit-large-patch14")
ap.add_argument("--no-flexar", action="store_true")
ap.add_argument("--no-clip", action="store_true")
ap.add_argument("--research", default=RESEARCH)
args = ap.parse_args()

state = {"ready": False, "flexar": False, "clip": False, "device": None, "error": None}
jobs = {}
jobs_lock = threading.Lock()
clip_lock = threading.Lock()


class GPU:
	# One model call at a time. Callers marked urgent (rungs someone is about to see) always go
	# before background FlexAR generation.
	def __init__(self):
		self.cv = threading.Condition()
		self.busy = False
		self.urgent = 0

	@contextlib.contextmanager
	def use(self, urgent=False):
		with self.cv:
			if urgent:
				self.urgent += 1
			while self.busy or (not urgent and self.urgent):
				self.cv.wait()
			if urgent:
				self.urgent -= 1
			self.busy = True
		try:
			yield
		finally:
			with self.cv:
				self.busy = False
				self.cv.notify_all()


gpu = GPU()


def load():
	try:
		import torch
		sys.path.insert(0, args.research)
		sys.path.insert(0, os.path.join(args.research, "models"))
		from models.flextok.flextok_wrapper import FlexTokFromHub
		from utils.models.flextok_io import use_dense_attention, tokenize_images
		import flextok.flow_matching.cfg_utils as cu

		# MPS has no float64; APG's projection casts to it, so do the same maths in float32
		def project32(v0, v1):
			dtype = v0.dtype
			v0, v1 = v0.float(), v1.float()
			v1 = torch.nn.functional.normalize(v1, dim=[-1, -2, -3])
			par = (v0 * v1).sum(dim=[-1, -2, -3], keepdim=True) * v1
			return par.to(dtype), (v0 - par).to(dtype)
		cu.project = project32

		dev = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
		t0 = time.time()
		model = FlexTokFromHub.from_pretrained(args.model).eval().to(dev)
		if args.decoder_weights:
			sd = torch.load(args.decoder_weights, map_location=dev)
			sd = sd.get("state_dict", sd) if isinstance(sd, dict) else sd
			missing, unexpected = model.decoder.load_state_dict(sd, strict=False)
			print(f"decoder weights {args.decoder_weights}: {len(missing)} missing, {len(unexpected)} unexpected keys", flush=True)
		use_dense_attention(model)
		state.update(torch=torch, model=model, tokenize=tokenize_images, device=dev)

		# One warm-up decode so the first real photo isn't slowed by kernel compilation
		next(ladder(np.full((256, 256, 3), 128, np.uint8)))
		state["ready"] = True
		print(f"FlexTok ready on {dev} in {time.time() - t0:.0f}s ({args.steps} steps, guidance up to {args.guidance_until} tokens)", flush=True)
	except Exception as e:
		state["error"] = repr(e)
		print("FlexTok failed to load:", e, flush=True)
		return

	if not args.no_clip:
		try:
			from transformers import CLIPModel, CLIPProcessor
			t0 = time.time()
			state["clip_model"] = CLIPModel.from_pretrained(args.clip_model).eval()  # CPU: keeps the GPU for FlexTok
			state["clip_proc"] = CLIPProcessor.from_pretrained(args.clip_model)
			state["clip_cache"] = collections.OrderedDict()
			# Warm up: the first CPU pass through ViT-L/14 takes several seconds, too slow for a live guess
			buf = io.BytesIO()
			Image.new("RGB", (256, 256), (90, 120, 80)).save(buf, "JPEG")
			judge(buf.getvalue(), ["grass"], "lawn")
			state["clip"] = True
			print(f"CLIP judge ready in {time.time() - t0:.0f}s", flush=True)
		except Exception as e:
			print("CLIP failed to load, judging falls back to spelling:", e, flush=True)

	if not args.no_flexar:
		try:
			from flextok_ar.utils.helpers import load_model
			t0 = time.time()
			ar, _, _ = load_model(args.ar_model, device=dev)
			state["ar"] = ar
			state["flexar"] = True
			print(f"FlexAR ready in {time.time() - t0:.0f}s", flush=True)
		except Exception as e:
			print("FlexAR failed to load, Imagine rounds are off:", e, flush=True)


def square256(raw: bytes) -> np.ndarray:
	img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
	return np.array(ImageOps.fit(img, (256, 256), Image.BICUBIC))


def decode_rung(ids, k) -> str:
	# Decodes the first k tokens to a base64 JPEG; the caller holds the GPU
	torch, model = state["torch"], state["model"]
	g = args.guidance if k <= args.guidance_until else 1.0  # 1.0 skips the unconditional pass
	with torch.inference_mode():
		x = model.detokenize([ids[:, :k]], timesteps=args.steps, guidance_scale=g, perform_norm_guidance=True, verbose=False)
	img = ((x[0].float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
	buf = io.BytesIO()
	Image.fromarray(img).save(buf, "JPEG", quality=88)
	return base64.b64encode(buf.getvalue()).decode()


def ladder(photo: np.ndarray):
	# Camera rounds: yields (rung, base64 JPEG) from 1 token up to 256
	torch = state["torch"]
	with gpu.use(urgent=True), torch.inference_mode():
		ids = state["tokenize"](state["model"], photo[None], state["device"])
	torch.manual_seed(random.randrange(2**31))  # each development re-imagines the detail
	for i, k in enumerate(TOKENS):
		with gpu.use(urgent=True):
			b64 = decode_rung(ids, k)
		yield i, b64  # outside the lock: the GPU isn't held while the rung is sent


class Job:
	# FlexAR writing one picture's 256 tokens in the background
	def __init__(self, label):
		self.id = base64.urlsafe_b64encode(os.urandom(9)).decode()
		self.label = label
		self.ids = None
		self.n = 0
		self.done = False
		self.error = None
		self.cancelled = False
		self.created = time.time()
		self.cv = threading.Condition()

	def run(self):
		torch, ar = state["torch"], state["ar"]
		t0 = time.time()
		try:
			ids = None
			for t in AR_CHUNKS:
				if self.cancelled:
					return
				with gpu.use(urgent=False), torch.inference_mode():
					data = {"target": torch.tensor([self.label], device=state["device"])}
					if ids is not None:
						data[ar.read_key] = ids
					out = ar.generate_ids(data, sample=True, temperature=1.0, top_k=0, top_p=0.0, cfg_factor=args.ar_cfg, num_keep_tokens=t, num_samples=1)
				ids = out[:, :t]
				with self.cv:
					self.ids, self.n = ids, t
					self.cv.notify_all()
			print(f"FlexAR wrote 256 tokens for class {self.label} in {time.time() - t0:.1f}s", flush=True)
		except Exception as e:
			self.error = repr(e)
			print("FlexAR generation failed:", e, flush=True)
		finally:
			with self.cv:
				self.done = True
				self.cv.notify_all()

	def tokens(self, k):
		# Waits until the first k tokens exist
		with self.cv:
			while self.n < k and not self.done:
				self.cv.wait(timeout=1)
			if self.n < k:
				raise RuntimeError(self.error or "generation stopped")
			return self.ids[:, :k]


def start_job(label, replaces=None):
	with jobs_lock:
		now = time.time()
		for jid in [j for j, job in jobs.items() if now - job.created > JOB_TTL or j == replaces]:
			jobs.pop(jid).cancelled = True
		job = Job(label)
		jobs[job.id] = job
	threading.Thread(target=job.run, daemon=True).start()
	return job


def imagine_ladder(job):
	state["torch"].manual_seed(random.randrange(2**31))
	for i, k in enumerate(TOKENS):
		ids = job.tokens(k)
		with gpu.use(urgent=True):
			b64 = decode_rung(ids, k)
		yield i, b64


def clip_image(raw: bytes):
	key = hashlib.sha1(raw).hexdigest()
	cache = state["clip_cache"]
	if key in cache:
		cache.move_to_end(key)
		return cache[key]
	torch = state["torch"]
	img = Image.open(io.BytesIO(raw)).convert("RGB")
	with torch.inference_mode():
		px = state["clip_proc"](images=img, return_tensors="pt")["pixel_values"]
		e = torch.nn.functional.normalize(state["clip_model"].get_image_features(pixel_values=px), dim=-1)[0]
	cache[key] = e
	while len(cache) > 64:
		cache.popitem(last=False)
	return e


def judge(raw: bytes, answers: list, guess: str) -> dict:
	torch = state["torch"]
	with clip_lock:
		ie = clip_image(raw)
		texts = [f"a photo of a {t}." for t in answers + [guess]]
		tok = state["clip_proc"](text=texts, return_tensors="pt", padding=True)
		with torch.inference_mode():
			te = torch.nn.functional.normalize(state["clip_model"].get_text_features(**tok), dim=-1)
	sims = (te @ ie).tolist()
	margin = sims[-1] - max(sims[:-1])
	text = max((te[:-1] @ te[-1]).tolist())
	words = guess.lower().strip().split()
	generic = len(words) == 1 and (words[0] in GENERIC or words[0].rstrip("s") in GENERIC)
	if margin >= MATCH_MARGIN and text >= TEXT_FLOOR and not generic:
		verdict = "match"
	elif margin >= WARM_MARGIN:
		verdict = "warm"
	else:
		verdict = "miss"
	return {"verdict": verdict, "margin": round(margin, 4), "text": round(text, 4)}


class Handler(BaseHTTPRequestHandler):
	def send_json(self, code, obj):
		body = json.dumps(obj).encode()
		self.send_response(code)
		self.send_header("content-type", "application/json")
		self.send_header("content-length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def body(self):
		n = int(self.headers.get("content-length") or 0)
		if not 0 < n <= MAX_BODY:
			raise ValueError("bad body")
		return self.rfile.read(n)

	def stream(self, rungs):
		# HTTP/1.0 response: no length, the body ends when the connection closes
		self.send_response(200)
		self.send_header("content-type", "application/x-ndjson")
		self.end_headers()
		t0 = time.time()
		try:
			for i, b64 in rungs:
				self.wfile.write((json.dumps({"rung": i, "image": b64, "seconds": time.time() - t0}) + "\n").encode())
				self.wfile.flush()
			print(f"ladder developed in {time.time() - t0:.1f}s", flush=True)
		except (BrokenPipeError, ConnectionResetError):
			print("game server hung up mid-ladder", flush=True)
		except Exception as e:
			print("ladder failed:", e, flush=True)

	def do_GET(self):
		if self.path == "/health":
			return self.send_json(200, {k: state[k] for k in ("ready", "flexar", "clip", "device", "error")} | {"steps": args.steps})
		self.send_json(404, {"error": "not found"})

	def do_POST(self):
		if not state["ready"]:
			return self.send_json(503, {"error": "model still loading"})
		try:
			raw = self.body()
		except ValueError:
			return self.send_json(400, {"error": "bad body"})

		if self.path == "/ladder":
			try:
				photo = square256(raw)
			except Exception:
				return self.send_json(400, {"error": "not an image"})
			return self.stream(ladder(photo))

		try:
			req = json.loads(raw)
		except ValueError:
			return self.send_json(400, {"error": "bad json"})

		if self.path == "/imagine/start":
			if not state["flexar"]:
				return self.send_json(503, {"error": "FlexAR isn't loaded"})
			label = req.get("label")
			if not isinstance(label, int) or not 0 <= label < 1000:
				return self.send_json(400, {"error": "label must be 0-999"})
			return self.send_json(200, {"job": start_job(label, req.get("replaces")).id})

		if self.path == "/imagine/ladder":
			job = jobs.get(req.get("job"))
			if not job:
				return self.send_json(404, {"error": "no such job"})
			return self.stream(imagine_ladder(job))

		if self.path == "/judge":
			if not state["clip"]:
				return self.send_json(503, {"error": "CLIP isn't loaded"})
			try:
				image = base64.b64decode(req["image"])
				answers = [str(a)[:60] for a in req["answers"]][:20]
				guess = str(req["guess"])[:60]
				assert answers and guess
			except Exception:
				return self.send_json(400, {"error": "need image, answers and guess"})
			return self.send_json(200, judge(image, answers, guess))

		self.send_json(404, {"error": "not found"})

	def log_message(self, fmt, *a):
		pass


if __name__ == "__main__":
	threading.Thread(target=load, daemon=True).start()
	print(f"Game models listening on http://127.0.0.1:{args.port} (loading...)", flush=True)
	ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
