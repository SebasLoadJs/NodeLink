"""Resolve only inspected, additive observer/configuration merge conflicts.
Unexpected source conflicts remain untouched and stop validation.
"""
import pathlib
import re
import subprocess
import sys

pr = sys.argv[1]
if pr not in ("268", "269"):
    sys.exit(0)
paths = subprocess.check_output(["git", "diff", "--name-only", "--diff-filter=U"], text=True).splitlines()
pattern = re.compile(r"^<<<<<<<[^\n]*\n(.*?)^=======[^\n]*\n(.*?)^>>>>>>>[^\n]*\n", re.M | re.S)
allowed = {"config.default.ts", "src/playback/player.ts", "src/playback/processing/streamProcessor.ts", "src/typings/config/config.types.ts", "src/typings/playback/player.types.ts"}
for name in paths:
    if name not in allowed:
        continue
    p = pathlib.Path(name)
    original = p.read_text()
    def resolve(m):
        a, b = m.group(1), m.group(2)
        if name == "src/playback/player.ts":
            if all("    return {\n" in t for t in (a,b)) and "const visualization" in a and ("const musicAnalysis" in b or "const audioProcessing" in b):
                x, y = a.split("    return {\n", 1)
                u, v = b.split("    return {\n", 1)
                return x+u+"    return {\n"+y+v
        elif name == "src/playback/processing/streamProcessor.ts" and pr == "268":
            if a.startswith("import { AudioVisualization }") and b.startswith("import { MusicAnalysis }"):
                return a+b
            if "getAudioVisualization?: () =>" in a and "getMusicAnalysis?: () =>" in b:
                return a+"          | null\n"+b
            if "voiceStream.getAudioVisualization =" in a and "voiceStream.getMusicAnalysis =" in b:
                return a+b
            if "  getAudioVisualization():" in a and "  getMusicAnalysis():" in b:
                return a+"  }\n\n"+b
            if "const observer = new AudioVisualization()" in a and "const observer = new MusicAnalysis()" in b:
                return a+"      streams.push(observer)\n      this.pipes?.push(observer)\n    }\n"+b
        elif name in ("config.default.ts", "src/typings/config/config.types.ts", "src/typings/playback/player.types.ts"):
            if name == "src/typings/playback/player.types.ts" and "getAudioVisualization?: () =>" in a and "getMusicAnalysis?: () =>" in b:
                return a+"    | null\n"+b
            if ("visualization" in a.lower() and ("musicanalysis" in b.lower() or "protected" in b or "audioProcessing" in b)):
                return a+b
        return m.group(0)
    updated = pattern.sub(resolve, original)
    if updated != original:
        p.write_text(updated)
        if not pattern.search(updated):
            subprocess.run(["git", "add", "--", name], check=True)
            print("Resolved inspected additive conflicts:", name)
