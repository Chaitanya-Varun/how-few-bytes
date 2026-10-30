# How Few Bytes?

A real-time party game for the **Semantic Camera** project, for 2–8 players on their own phones. One player photographs
something (or has FlexAR imagine it) and the others name it from as few bytes as possible while the picture develops from
2 bytes up to 512. It is the proposal's *guess-the-object* sidekick turned into a multiplayer game.

## Rules

1. **Shoot.** Each round one player is the photographer (the role rotates in join order). They have 60 s to photograph
   something and secretly type what it is, plus any other answers they'd accept ("mug, cup"). On the laptop they can
   instead pick **Imagine**: choose one of the 1000 ImageNet classes and FlexAR writes the picture's tokens from scratch
   (the class name and its synonyms are the answers). Adding 3 decoys makes the round **multiple choice**.
2. **Call it (optional).** The photographer bets on the byte level at which someone will first guess right.
3. **Develop.** The photo is cut to its first *k* FlexTok tokens (2 bytes each) and developed at 9 levels:
   2, 4, 8, 16, 32, 64, 128, 256 and 512 bytes. After a 3 s countdown, every phone steps up one level every 5 s.
4. **Guess.** Each guesser gets one guess per level. Wrong guesses cost nothing. Exact answers, plurals and small typos
   are accepted automatically; on the laptop, CLIP judges the rest by meaning against the picture ("puppy" for "dog"
   counts, and a near miss shows **Close!**). The photographer sees every guess live and can tap to accept or reject one,
   even after the round ends. In a multiple-choice round each guesser gets one tap for the whole round, so waiting for
   more bytes is the gamble.
5. **Score.** A correct guess earns points by level: 100 at 2 B, then 90, 80, 70, 60, 50, 40, 30, and 20 at 512 B. The photographer
   earns half the best guesser's points (nothing if nobody gets it), plus 25 if the first correct guess lands exactly on the bet.
6. **End.** A round ends when every guesser is right or after 512 B. The game ends when everyone has shot once (twice with
   2–3 players). Most points wins, and ties go to the lower average number of bytes needed. The final screen shows the room's
   *semantic threshold*: the average number of bytes at which its photos were first recognised.

## Two deployments, one game

|                 | Laptop + tunnel (main)                          | Netlify (always-on fallback)                |
|-----------------|-------------------------------------------------|---------------------------------------------|
| Pictures        | **FlexTok** on the laptop's GPU; **FlexAR** for Imagine rounds; **CLIP** judges guesses | Stand-in decoder in the browser; spelling + photographer judge; no Imagine |
| Server          | `server/local.js`, rooms in memory              | `netlify/functions/game.ts`, Netlify Blobs  |
| Reachable at    | `https://<random>.trycloudflare.com` while running | `https://<site>.netlify.app`, always    |

Both run the same rules (`shared/logic.js`) behind the same API (`shared/handler.js`, at `/.netlify/functions/game`), so the
phone page (`public/`) works unchanged on either. The **stand-in decoder** (`public/standin.js`) is the classical baseline from the
proposal: equal-byte down-sampling. Each level keeps exactly as many bytes as FlexTok would, as a tiny image in YCbCr (grey
below 32 B, 4:2:0 chroma above), and is scaled back up with bilinear smoothing.

## Game night on the laptop

```bash
scripts/play.sh
```

This starts the models server (FlexTok, FlexAR and CLIP, in the `IF_py3p11` env), the game server and a Cloudflare quick
tunnel, then prints a public `https://….trycloudflare.com` link. Send that link to the players. HTTPS also lets phones use the live camera.
Ctrl-C stops everything.

- The models take about a minute to load (FlexTok ~20 s, CLIP ~6 s, FlexAR ~35 s). Until they're ready, the game plays
  with the stand-in decoder, spelling-only judging and no Imagine tab.
- `scripts/play.sh --no-flextok` uses the stand-in only. `--local` skips the tunnel (`http://localhost:8787`).
- `FLEXTOK_PYTHON=/path/to/python` points to a different environment.
- `decoder/flextok_server.py --decoder-weights ckpt.pt` loads a state dict into `model.decoder`, e.g. your fine-tuned
  decoder. This flag has not been tried with your checkpoint format yet.

**Timing on the M5 Pro** (d18-d28 in1k, 8 steps, batch 1): each rung takes 4.3 s with guidance 7.5 and 2.2 s without.
Guidance is only used for 1–4 tokens (2–8 B), where it keeps the subject recognisable; above that the pictures look the
same either way. That makes a full ladder about 26 s instead of 39 s. Rungs stream to the server as they finish. The 3 s
countdown runs while the first rung decodes, so the picture appears about 1 s after it exists. Each rung is shown for 5 s,
so decoding stays ahead of the reveal.

Things that don't help on MPS: FP8 (not supported), fp16/bf16 weights (a Metal matmul assertion), autocast (slower than
fp32), batching prefixes (dense attention makes 3 at once slower than 3 singles), and 4 steps (blurs the low rungs).

**Imagine rounds.** FlexAR-1B-C2I has no KV cache, so 256 tokens take ~37 s on MPS (16 take 0.6 s). Generation starts
the moment the photographer picks a class, in chunks that let rung decodes cut in, and the ladder decodes each prefix as
soon as it exists, so the round starts about 6 s after "Send". Rungs FlexAR never reaches repeat the last one it did.

**Judging.** CLIP ViT-L/14 runs on the CPU (the GPU is for FlexTok). A guess is a match when its similarity to the picture is
within 0.035 of the best accepted answer's and it is at least loosely related to an answer as text; within 0.045 is "Close!".
Category words ("animal", "food") are capped at Close!. Thresholds were tuned on ~100 guess pairs over FlexAR pictures
(`decoder/flextok_server.py`). A judge call takes ~50 ms after the first one per picture.

## Netlify fallback

Live at <https://how-few-bytes.netlify.app>. The folder is linked to that Netlify project, so after a change:

```bash
netlify deploy --prod
```

(Or `scripts/package-netlify.sh` writes `netlify-ready-game.zip` for <https://app.netlify.com/drop>.)

## Tests

```bash
npm test
```

- `test/sim.mjs` plays full games with 2, 3, 4 and 8 players with a fake clock. It covers scoring, bets, judging, hidden
  answers and images, timeouts, leaving, host hand-off, and the FlexTok path, including a decoder that dies mid-ladder.
- `test/modes.mjs` covers alternate answers, CLIP verdicts (match / Close! / miss, and a judge that is down), multiple
  choice, and Imagine rounds (class synonyms, a FlexAR that stops early, a FlexAR that fails before the first picture).
- `test/netlify-fn.mjs` runs the real Netlify function against Netlify's local Blobs server.

To play-test locally, open `http://localhost:8787` in two tabs (each tab is its own player) and pick any photo file.
