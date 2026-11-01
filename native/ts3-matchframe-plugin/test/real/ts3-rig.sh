#!/usr/bin/env bash
# The real TeamSpeak rig for Team Comms (Linux, docs/operations/team-comms.md): the official TeamSpeak 3
# server, two listener TeamSpeak 3 clients with the plugin (Team Alpha, Team Bravo) and up to 14
# talking clients, each with its own identity and a distinct tone as its microphone (PulseAudio null
# sinks), all under Xvfb. TeamSpeak is not in the repository: download and extract it yourself
# (licences: the server's LICENSE, accepted by TS3SERVER_LICENSE=accept below; the client's terms,
# accepted by its installer).
#
#   TS3_SERVER_DIR=<extracted teamspeak3-server_linux_amd64> TS3_CLIENT_DIR=<extracted client> \
#   PLUGIN=<built matchframe_comms_linux_amd64.so> BRIDGE_FILE=<engine data>/team-comms/bridge.json \
#   WORK=<empty folder> PEOPLE=7 ts3-rig.sh start|stop
#
# Then: MATCHFRAME_TS3_RIG=$WORK pnpm vitest run services/local-engine/test/team-comms.ts3.integration.test.ts
# Needs: Xvfb, pulseaudio + pulseaudio-utils, libasound2-plugins, ffmpeg (lavfi + pulse), sqlite3, curl,
# xdotool, libevent-2.1-7. Tested with server 3.13.8 and client 3.6.2 (plugin API 26).
set -euo pipefail
: "${WORK:?}" "${TS3_SERVER_DIR:?}" "${TS3_CLIENT_DIR:?}" "${PLUGIN:?}" "${BRIDGE_FILE:?}"
PEOPLE=${PEOPLE:-7}
DISPLAY_NUM=${DISPLAY_NUM:-:71}
export XDG_RUNTIME_DIR="$WORK/run"
FA=(330 470 610 750 890 1030 1170)
FB=(1310 1450 1590 1730 1870 2010 2150)

home_pid() { for p in $(pgrep -x ts3client_linux || true); do tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qx "HOME=$1" && echo "$p"; done; }
client() { # client <home> [args...]
  local h="$1"; shift
  (cd "$TS3_CLIENT_DIR" && HOME="$h" DISPLAY="$DISPLAY_NUM" QTWEBENGINE_DISABLE_SANDBOX=1 QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-gpu" \
    LIBGL_ALWAYS_SOFTWARE=1 KDEDIRS= KDEDIR= QTDIR=. QT_PLUGIN_PATH=. LD_LIBRARY_PATH=".:${LD_LIBRARY_PATH:-}" ./ts3client_linux_amd64 "$@")
}
webquery() { curl -sS -H "x-api-key: $(cat "$WORK/apikey")" "http://127.0.0.1:10080/1/$1"; }

if [ "${1:-}" = stop ]; then
  pkill -x ts3client_linux || true
  for p in $(pgrep -x ffmpeg || true); do grep -q "matchframe-rig-tone" "/proc/$p/cmdline" 2>/dev/null && kill "$p"; done
  [ -f "$WORK/server.pid" ] && kill "$(cat "$WORK/server.pid")" 2>/dev/null || true
  [ -f "$WORK/xvfb.pid" ] && kill "$(cat "$WORK/xvfb.pid")" 2>/dev/null || true
  pulseaudio -k 2>/dev/null || true
  exit 0
fi

mkdir -p "$WORK/run" "$WORK/server" "$WORK/h"
chmod 700 "$WORK/run"
# Display and sound.
if ! pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null; then Xvfb "$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 & echo $! >"$WORK/xvfb.pid"; fi
pulseaudio -D --exit-idle-time=-1 --disallow-exit -n -L module-native-protocol-unix -L module-null-sink -L module-always-sink --log-target="file:$WORK/pulse.log" >/dev/null 2>&1 || true
sleep 2
pactl load-module module-null-sink sink_name=listen_out rate=48000 channels=2 >/dev/null
pactl load-module module-null-sink sink_name=talk_out rate=48000 channels=2 >/dev/null
# The server (free licence: one virtual server, 32 slots), with a WebQuery key.
cp -r "$TS3_SERVER_DIR/." "$WORK/server/"
(cd "$WORK/server" && TS3SERVER_LICENSE=accept LD_LIBRARY_PATH=. ./ts3server serveradmin_password=rig-admin >"$WORK/server.log" 2>&1 & echo $! >"$WORK/server.pid")
# (The HTTP query starts after the SSH host key is made: seconds after the API key is printed.)
for _ in $(seq 120); do grep -q 'listening for http query' "$WORK/server.log" 2>/dev/null && break; sleep 0.5; done
grep -o 'apikey= "[^"]*"' "$WORK/server.log" | sed 's/apikey= "//; s/"$//' >"$WORK/apikey"
sleep 2
webquery "channelcreate?channel_name=Team%20Alpha&channel_flag_permanent=1&channel_codec=4&channel_codec_quality=10" >/dev/null
webquery "channelcreate?channel_name=Team%20Bravo&channel_flag_permanent=1&channel_codec=4&channel_codec_quality=10" >/dev/null
# A test server: 16 clients from 127.0.0.1 in a short time would trip its flood prevention.
webquery "serveredit?virtualserver_antiflood_points_needed_ip_block=20000&virtualserver_antiflood_points_tick_reduce=200&virtualserver_antiflood_points_needed_command_block=20000" >/dev/null

# A first client run makes the settings database; talkers get it with voice activation by level only
# (the default "hybrid" mode doesn't take pure tones for voice).
T="$WORK/h/template"
mkdir -p "$T"
client "$T" -nosingleinstance >/dev/null 2>&1 &
for _ in $(seq 40); do [ -f "$T/.ts3client/settings.db" ] && break; sleep 0.5; done
sleep 4
kill "$(home_pid "$T")" || true
sleep 1
sqlite3 "$T/.ts3client/settings.db" "update Profiles set value='denoise=false
continous_transmission=false
vad=true
voiceactivation_level=-50
agc=false
vad_over_ptt=false
vad_mode=1' where key='Capture/Default/PreProcessing'"

# The listeners: one TeamSpeak client per team, each with the plugin and its own identity (a default
# server allows one connection per identity), connected at launch. (One client with two tabs works too
# when the identities differ or the server allows clones: docs/operations/team-comms.md.)
for team in Alpha Bravo; do
  L="$WORK/h/listener-$team"
  mkdir -p "$L/.ts3client/plugins"
  # Past the client's first run (a fresh client ignores the address it is started with).
  cp "$T/.ts3client/settings.db" "$L/.ts3client/"
  cp "$PLUGIN" "$L/.ts3client/plugins/"
  MATCHFRAME_COMMS_BRIDGE_FILE="$BRIDGE_FILE" PULSE_SINK=listen_out PULSE_SOURCE=talk_out.monitor client "$L" -nosingleinstance "ts3server://127.0.0.1?port=9987&nickname=MF%20Listener%20$team&channel=Team%20$team" >"$WORK/listener-$team.log" 2>&1 &
  sleep 6
done

# Talkers: a tone each, 2 s every 6 s, person i 0.7 s after person i-1 (3 talk at once).
for i in $(seq 0 $((PEOPLE - 1))); do
  n=$((i + 1))
  for team in A B; do
    if [ $team = A ]; then f=${FA[$i]}; off=$(awk "BEGIN{print $i*0.7}"); name="Alpha%20$n"; ch="Team%20Alpha";
    else f=${FB[$i]}; off=$(awk "BEGIN{print $i*0.7+0.35}"); name="Bravo%20$n"; ch="Team%20Bravo"; fi
    pactl load-module module-null-sink "sink_name=t$team$n" rate=48000 channels=1 >/dev/null
    ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=$f:sample_rate=48000" -af "volume='if(lt(mod(t+$off\,6)\,2)\,0.5\,0)':eval=frame" -ac 1 -f pulse -device "t$team$n" "matchframe-rig-tone-$team$n" >/dev/null 2>&1 &
    sleep 0.3
    H="$WORK/h/t$team$n"
    mkdir -p "$H/.ts3client"
    cp "$T/.ts3client/settings.db" "$H/.ts3client/"
    PULSE_SOURCE="t$team$n.monitor" PULSE_SINK=talk_out client "$H" -nosingleinstance "ts3server://127.0.0.1?port=9987&nickname=$name&channel=$ch" >"$WORK/talker-$team$n.log" 2>&1 &
    sleep 1.5
  done
done
sleep 12
# First-run dialogs off (they don't block audio, but keep the screen readable).
for p in $(pgrep -x ts3client_linux || true); do for w in $(DISPLAY="$DISPLAY_NUM" xdotool search --pid "$p" 2>/dev/null || true); do
  case "$(DISPLAY="$DISPLAY_NUM" xdotool getwindowname "$w" 2>/dev/null)" in "myTeamSpeak Account"|"Use Privilege Key"|Introducing*) DISPLAY="$DISPLAY_NUM" xdotool windowclose "$w" 2>/dev/null || true;; esac
done; done
echo "TeamSpeak rig up: $(webquery clientlist | grep -o 'client_nickname' | wc -l) clients on the server"
