# Handshake submission

## Project title

How Few Bytes? — a party game played on 2 bytes of photo

## Description (500 characters; this one is 492)

Snap a photo, friends race to name it as it develops from 2 bytes to 512. Guess early, score big. Inspired by my research: with the FlexTok tokenizer I study, a whole scene fits in 32 bytes, smaller than a text, and the AI re-imagines the rest. Hardest part: making a 13 s decode feel live (it streams level by level). Most fun: "Imagine" rounds, where FlexAR dreams up a thing and everyone guesses. Learned: a party game is an honest model eval. Next: a leaderboard. Rules in-app, 2–8 players.

## Longer version, if the limit is words rather than characters

**Inspiration.** My ECEN 5672 project, Semantic Camera, started from a line in my proposal: 32 bytes fit in a text message or a satellite messenger's 160-character limit, and the smallest JPEG of the same photo needs 1,814 bytes and is still blocky. The tokenizer I study, FlexTok, turns a photo into 256 tokens ordered from coarse to fine, and any first few of them decode to a complete picture: the meaning arrives first, the detail gets re-imagined. The obvious question was "how few bytes does a person need to recognise a scene?", and the obvious way to measure that was to make friends compete at it.

**The game.** One player photographs something nearby. Everyone else watches it develop on their own phone, from 2 bytes to 512, a new level every 5 seconds, and races to name it. Fewer bytes, more points; the photographer scores too, so the game rewards photos whose meaning survives in a handful of bytes. Imagine rounds flip it: pick any of 1,000 things, FlexAR writes the picture from scratch, and the others guess what it dreamed up. Guesses are judged by meaning ("puppy" counts for "dog"), near misses show "Close!", and the photographer can turn a round into multiple choice with three decoys. Every game ends with the room's "semantic threshold": the average number of bytes at which a human recognised a picture.

**Challenging.** A full-quality decode takes 13 seconds, which is an eternity in a party game. The fix was to stream each byte level to the phones the moment it finishes, run guidance only on the smallest levels where it matters, and overlap the countdown with the first decode, so a round starts about 4 seconds after the shutter. Also: two phones polling at the same instant could mark a player "away" and skip their turn. Found by playing, not by tests.

**Fun.** Watching a 2-byte blob become a golden retriever at 16 bytes, and watching people yell "DOG" at 8.

**Learned.** A game is a surprisingly honest evaluation of a compression model: PSNR says a 32-byte picture is terrible, but a room full of people recognises it at 16 bytes. Also that FP8 is not a thing on Apple GPUs.

**Next.** A cross-room leaderboard, free-text prompts for Imagine rounds, and the fine-tuned decoder from my research as the default.

## Notes for the form

- **Your project (link):** the Netlify URL once `netlify-ready-game.zip` is deployed (always on, stand-in decoder). The laptop link with FlexTok/FlexAR only works while `scripts/play.sh` runs.
- **Preview image:** `cover.png` (3:2, 1800×1200).
- Everything above is true of the project as built; the "found by playing" bug and the FP8 result are from this build's testing.
