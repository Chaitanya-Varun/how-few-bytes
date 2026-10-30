# Writes public/imagenet-classes.json: the 1000 ImageNet classes FlexAR-1B-C2I can imagine, as
# [name, [synonyms]] by class index. Names are open_clip's cleaned ones ("Egyptian Mau"); the
# torchvision/WordNet name is kept as a synonym when it differs ("Egyptian cat").
#   ~/miniforge3/envs/IF_py3p11/bin/python scripts/make_classes.py
import json, os
import torchvision
from open_clip.zero_shot_metadata import IMAGENET_CLASSNAMES

wordnet = torchvision.models.ResNet50_Weights.IMAGENET1K_V2.meta["categories"]
out = []
for clean, wn in zip(IMAGENET_CLASSNAMES, wordnet):
	alts = [] if wn.lower() == clean.lower() else [wn]
	out.append([clean, alts])
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "imagenet-classes.json")
with open(path, "w") as f:
	json.dump(out, f, separators=(",", ":"))
print(f"wrote {len(out)} classes to {os.path.normpath(path)}")
