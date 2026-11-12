#!/bin/sh
# cut.sh name [fps] [width] : raw/<name>.json → out/<name>.gif and .mp4
# CROP=390:800:0:0 ./cut.sh phone 12 390 for the phone scene (recorded in a wider frame)
n=$1; fps=${2:-12}; w=${3:-1080}
f=$(python3 -c "import json;d=json.load(open('raw/$n.json'));print(d['file'])")
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
read ss t <<X
$(python3 -c "import json;d=json.load(open('raw/$n.json'));L=d['to']-d['from'];print(max(0,$dur-(d['to']-d['from'])-0.15), L)")
X
mkdir -p out
ffmpeg -loglevel error -y -ss $ss -i "$f" -vf "${CROP:+crop=$CROP,}fps=$fps,scale=$w:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" out/$n.gif
ffmpeg -loglevel error -y -ss $ss -i "$f" ${CROP:+-vf crop=$CROP} -an -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart out/$n.mp4
ls -la out/$n.*; echo "ss=$ss len=$t dur=$dur"
