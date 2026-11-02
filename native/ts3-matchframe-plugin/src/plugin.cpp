// MatchFrame Team Comms: a TeamSpeak 3 client plugin that hands each team member's decoded voice,
// before TeamSpeak mixes it, to MatchFrame over 127.0.0.1 (docs/operations/team-comms.md, ADR-065).
//
// Threads:
// - TeamSpeak's playback thread calls ts3plugin_onEditPlaybackVoiceDataEvent once per client and
//   block. On a connection MatchFrame manages, the samples are copied into a bounded lock-free queue
//   (a full queue drops the block and counts it; the callback never waits), then zeroed so the
//   listener tab plays nothing on this computer.
// - TeamSpeak's main thread calls the event callbacks (connections, clients moving, nicknames,
//   talking). They update a small identity cache and queue an event for MatchFrame.
// - The sender thread (ours) connects to MatchFrame, sends the audio with each speaker's unique
//   identity and a monotonic timestamp, the events and statistics, and applies MatchFrame's
//   commands: which connections to capture, keeping their microphones off, recording status.
//
// MatchFrame's address and token come from <MatchFrame data folder>/team-comms/bridge.json, which
// the engine writes. Nothing is captured until MatchFrame says which connections are the teams'.
//
// The team tabs are remembered (server and channel, in <TeamSpeak config>/matchframe_comms_tabs.txt):
// while any are, a connection the plugin hasn't settled yet is silent here from its first block (the
// playback thread can start before TeamSpeak's main thread reports the connection); once its channel
// is known it is a team tab (listen-only and silent, before MatchFrame answers; capture still waits
// for MatchFrame) or TeamSpeak's own (released: it plays).

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "platform.hpp"
#include "queue.hpp"

#include "plugin_definitions.h"
#include "teamspeak/public_definitions.h"
#include "teamspeak/public_errors.h"
#include "teamspeak/public_rare_definitions.h"
#include "ts3_functions.h"

#if defined(_WIN32)
#define MF_EXPORT extern "C" __declspec(dllexport)
#else
#define MF_EXPORT extern "C" __attribute__((visibility("default")))
#endif

#ifndef MF_PLUGIN_VERSION
#define MF_PLUGIN_VERSION "0.2.0"
#endif

// TS3 client 3.6.x loads plugins built for API 26 only (client 3.6.0 changelog).
#ifndef PLUGIN_API_VERSION_USED
#define PLUGIN_API_VERSION_USED 26
#endif

namespace {

// ------------------------------------------------------------------------------------------------ wire
// Every message: "MFTC", version 1, type, 2 reserved bytes, payload length (u32 LE), payload.
constexpr uint8_t kProtocol = 1;
enum : uint8_t {
  kHello = 0x01,      // plugin -> engine, JSON {token, protocol, plugin, ts3, platform, clock}
  kWelcome = 0x02,    // engine -> plugin
  kEvent = 0x03,      // plugin -> engine, JSON
  kAudio = 0x04,      // plugin -> engine, binary (see appendAudio)
  kStats = 0x05,      // plugin -> engine, JSON, once a second
  kPong = 0x06,       // plugin -> engine: u64 engine time (echoed), u64 plugin time
  kError = 0x0F,      // engine -> plugin: UTF-8 reason; the engine then closes
  kManage = 0x10,     // engine -> plugin: u64 schid, u8 capture, u8 listenOnly, u8 suppressPlayback, u8 0
  kRecording = 0x11,  // engine -> plugin: u8 on, 3 x u8 0
  kSnapshot = 0x12,   // engine -> plugin: send every connection again
  kPing = 0x13,       // engine -> plugin: u64 engine time
};
constexpr size_t kHeader = 12;
constexpr size_t kMaxPayload = 1 << 20;
// TeamSpeak's playback callbacks carry 16-bit samples at 48 kHz (TS3 client SDK documentation;
// measured: docs/operations/team-comms.md).
constexpr uint32_t kPlaybackRate = 48000;

void put16(std::vector<uint8_t>& b, uint16_t v) {
  b.push_back(static_cast<uint8_t>(v));
  b.push_back(static_cast<uint8_t>(v >> 8));
}
void put32(std::vector<uint8_t>& b, uint32_t v) {
  for (int i = 0; i < 4; i++) b.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
void put64(std::vector<uint8_t>& b, uint64_t v) {
  for (int i = 0; i < 8; i++) b.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
uint64_t get64(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}
void header(std::vector<uint8_t>& b, uint8_t type, uint32_t len) {
  b.push_back('M');
  b.push_back('F');
  b.push_back('T');
  b.push_back('C');
  b.push_back(kProtocol);
  b.push_back(type);
  put16(b, 0);
  put32(b, len);
}
void message(std::vector<uint8_t>& out, uint8_t type, const std::string& payload) {
  header(out, type, static_cast<uint32_t>(payload.size()));
  out.insert(out.end(), payload.begin(), payload.end());
}

// ------------------------------------------------------------------------------------------------ JSON
std::string jsonString(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char u[8];
          std::snprintf(u, sizeof u, "\\u%04x", c);
          o += u;
        } else {
          o += static_cast<char>(c);
        }
    }
  }
  return o + "\"";
}

// A flat JSON object builder: J().s("a", "x").n("b", 1).raw("c", "[...]").str()
class J {
 public:
  J& s(const char* k, const std::string& v) { return raw(k, jsonString(v)); }
  J& n(const char* k, long long v) { return raw(k, std::to_string(v)); }
  J& u(const char* k, unsigned long long v) { return raw(k, std::to_string(v)); }
  J& b(const char* k, bool v) { return raw(k, v ? "true" : "false"); }
  J& raw(const char* k, const std::string& v) {
    o_ += (o_.size() > 1 ? "," : "") + jsonString(k) + ":" + v;
    return *this;
  }
  std::string str() const { return o_ + "}"; }

 private:
  std::string o_ = "{";
};

// ------------------------------------------------------------------------------------------------ state
TS3Functions ts3;
void logLine(const std::string& msg, LogLevel level = LogLevel_INFO);
char* g_pluginId = nullptr;

std::unique_ptr<mf::FrameQueue> g_queue;
std::atomic<bool> g_running{false};
std::thread g_sender;
std::atomic<uint64_t> g_queueDropped{0};
// Random per TeamSpeak process (set in init): MatchFrame tells a reconnect of this plugin from a new TeamSpeak.
std::string g_instance;

// Connections MatchFrame manages: read by the audio callback without a lock.
// kReleased: settled as not a team tab (it plays here). A connection with no flags while team tabs are
// remembered is not settled yet: silent here.
enum : uint32_t { kCapture = 1, kListenOnly = 2, kSuppress = 4, kReleased = 16 };
constexpr uint32_t kOurs = kCapture | kListenOnly | kSuppress;
// Team tabs are remembered: unsettled connections are silent (read by the audio callbacks, no lock).
std::atomic<bool> g_anyRemembered{false};
struct Managed {
  std::atomic<uint64_t> schid{0};
  std::atomic<uint32_t> flags{0};
};
constexpr int kMaxConnections = 16;
Managed g_managed[kMaxConnections];
std::atomic<bool> g_recording{false};

uint32_t managedFlags(uint64_t schid) {
  for (auto& m : g_managed)
    if (m.schid.load(std::memory_order_acquire) == schid) return m.flags.load(std::memory_order_acquire);
  return 0;
}
// Writers (the sender thread, and the main thread restoring a remembered tab) take this lock; the
// audio callback only reads, without it.
std::mutex g_managedMu;
void setManaged(uint64_t schid, uint32_t flags) {
  std::lock_guard<std::mutex> l(g_managedMu);
  for (auto& m : g_managed)
    if (m.schid.load() == schid) {
      m.flags.store(flags);
      return;
    }
  for (auto& m : g_managed)
    if (m.schid.load() == 0) {
      m.flags.store(flags);
      m.schid.store(schid, std::memory_order_release);
      return;
    }
}
void clearManagedBits(uint64_t schid, uint32_t bits) {
  std::lock_guard<std::mutex> l(g_managedMu);
  for (auto& m : g_managed)
    if (m.schid.load() == schid) m.flags.fetch_and(~bits);
}

// Per-connection callback counters, claimed lock-free by the audio callback.
struct CallbackStats {
  std::atomic<uint64_t> schid{0};
  std::atomic<uint64_t> voiceCalls{0}, voiceSamples{0}, captured{0}, dropped{0}, zeroed{0}, badFormat{0};
  std::atomic<uint64_t> mixedCalls{0}, mixedNonSilent{0}, mixedZeroed{0}, capturedSendBlocked{0};
  std::atomic<int> lastChannels{0}, lastSampleCount{0};
};
CallbackStats g_cb[kMaxConnections];

CallbackStats* statsFor(uint64_t schid) {
  for (auto& s : g_cb) {
    uint64_t cur = s.schid.load(std::memory_order_acquire);
    if (cur == schid) return &s;
    if (cur == 0) {
      uint64_t expected = 0;
      if (s.schid.compare_exchange_strong(expected, schid)) return &s;
      if (expected == schid) return &s;
    }
  }
  return nullptr;
}

// Identities and connection details: main thread and sender thread, never the audio callback.
struct ClientInfo {
  std::string uid, nickname;
  uint64_t channelId = 0;
};
struct ConnInfo {
  std::string host;
  unsigned short port = 0;
  anyID ownClientId = 0;
  uint64_t ownChannelId = 0;
  std::string serverUid, channelName;
};
std::mutex g_infoMu;
std::map<uint64_t, ClientInfo> g_clients;  // (schid << 16) | clientId
std::map<uint64_t, ConnInfo> g_conns;
uint64_t clientKey(uint64_t schid, anyID id) { return (schid << 16) | id; }
// Someone who left the tab's channel: their blocks captured before they left are still theirs, even
// once TeamSpeak gives their session id to someone else (kept a few seconds).
struct Departed {
  ClientInfo info;
  uint64_t leftUs = 0;
};
std::map<uint64_t, Departed> g_departed;
constexpr uint64_t kDepartedKeepUs = 5000000;
void noteDeparted(uint64_t key, const ClientInfo& c, uint64_t channelId) {  // under g_infoMu
  const uint64_t now = mf::monoUs();
  for (auto it = g_departed.begin(); it != g_departed.end();) it = now - it->second.leftUs > kDepartedKeepUs ? g_departed.erase(it) : std::next(it);
  Departed d;
  d.info = c;
  d.info.channelId = channelId;
  d.leftUs = now;
  g_departed[key] = d;
}

// ------------------------------------------------------------------------------------------------ remembered team tabs
// The tabs MatchFrame captured (server unique id and channel name), most recent first, so a restarted
// TeamSpeak keeps them listen-only and silent before MatchFrame answers. MatchFrame releasing a tab
// (MANAGE with no flags) forgets it.
struct RememberedTab {
  std::string serverUid, channel, host;
  unsigned short port = 0;
};
constexpr size_t kMaxRemembered = 4;
std::mutex g_rememberMu;
std::vector<RememberedTab> g_remembered;
std::string g_rememberFile;

std::string oneLine(const std::string& v) {
  std::string o = v;
  for (char& c : o)
    if (c == '\t' || c == '\n' || c == '\r') c = ' ';
  return o;
}

void loadRemembered() {
  std::lock_guard<std::mutex> l(g_rememberMu);
  g_remembered.clear();
  const std::string s = mf::readSmallFile(g_rememberFile, 16384);
  size_t pos = 0;
  bool first = true;
  while (pos < s.size()) {
    size_t e = s.find('\n', pos);
    if (e == std::string::npos) e = s.size();
    std::string line = s.substr(pos, e - pos);
    pos = e + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (first) {
      first = false;
      if (line != "MFTABS1" && line != "MFTABS2") return;
      continue;
    }
    // server uid, channel, and (MFTABS2) the address TeamSpeak connects to and its port.
    std::vector<std::string> f;
    size_t from = 0;
    for (;;) {
      const size_t t = line.find('\t', from);
      f.push_back(line.substr(from, t == std::string::npos ? std::string::npos : t - from));
      if (t == std::string::npos) break;
      from = t + 1;
    }
    if (f.size() < 2 || f[0].empty() || f[1].empty()) continue;
    RememberedTab r;
    r.serverUid = f[0];
    r.channel = f[1];
    if (f.size() >= 4) {
      r.host = f[2];
      r.port = static_cast<unsigned short>(std::strtoul(f[3].c_str(), nullptr, 10));
    }
    if (g_remembered.size() < kMaxRemembered) g_remembered.push_back(r);
  }
  g_anyRemembered = !g_remembered.empty();
}

void saveRemembered() {  // under g_rememberMu
  if (g_rememberFile.empty()) return;
  std::string out = "MFTABS2\n";
  for (auto& r : g_remembered) out += oneLine(r.serverUid) + "\t" + oneLine(r.channel) + "\t" + oneLine(r.host) + "\t" + std::to_string(r.port) + "\n";
  mf::writeSmallFile(g_rememberFile, out);
}

void remember(const std::string& serverUid, const std::string& channel, const std::string& host, unsigned short port, bool keep) {
  if (serverUid.empty() || channel.empty()) return;
  std::lock_guard<std::mutex> l(g_rememberMu);
  std::vector<RememberedTab> next;
  if (keep) {
    RememberedTab r;
    r.serverUid = serverUid;
    r.channel = channel;
    r.host = host;
    r.port = port;
    next.push_back(r);
  }
  for (auto& r : g_remembered)
    if (!(r.serverUid == serverUid && r.channel == channel) && next.size() < kMaxRemembered) next.push_back(r);
  bool same = next.size() == g_remembered.size();
  for (size_t i = 0; same && i < next.size(); i++) same = next[i].serverUid == g_remembered[i].serverUid && next[i].channel == g_remembered[i].channel && next[i].host == g_remembered[i].host && next[i].port == g_remembered[i].port;
  if (same) return;
  g_remembered.swap(next);
  g_anyRemembered = !g_remembered.empty();
  saveRemembered();
}

bool isRememberedServer(const std::string& serverUid) {
  std::lock_guard<std::mutex> l(g_rememberMu);
  for (auto& r : g_remembered)
    if (r.serverUid == serverUid) return true;
  return false;
}

// When each connection was established (TeamSpeak's main thread only): a new connection to a team's
// server is first placed in the server's default channel and moved on just after.
std::map<uint64_t, uint64_t> g_establishedUs;
constexpr uint64_t kSettleGraceUs = 3000000;

bool isRemembered(const std::string& serverUid, const std::string& channel) {
  std::lock_guard<std::mutex> l(g_rememberMu);
  for (auto& r : g_remembered)
    if (r.serverUid == serverUid && r.channel == channel) return true;
  return false;
}

std::mutex g_eventMu;
std::deque<std::string> g_events;
std::atomic<bool> g_eventsOverflowed{false};
constexpr size_t kMaxEvents = 4096;

void queueEvent(const std::string& json) {
  std::lock_guard<std::mutex> l(g_eventMu);
  if (g_events.size() >= kMaxEvents) {
    g_events.pop_front();
    g_eventsOverflowed = true;  // the sender sends a full snapshot after these
  }
  g_events.push_back(json);
}

// Takes a string TeamSpeak allocated (freeing it). The call must have run before: C++ leaves the
// order of a call's arguments unspecified, so never ts3String(f(&s), s).
std::string ts3String(unsigned int err, char* s) {
  if (err != ERROR_ok || !s) return std::string();
  std::string v(s);
  ts3.freeMemory(s);
  return v;
}
std::string clientString(uint64_t schid, anyID id, size_t flag) {
  char* s = nullptr;
  unsigned int err = ts3.getClientVariableAsString(schid, id, flag, &s);
  return ts3String(err, s);
}
std::string selfString(uint64_t schid, size_t flag) {
  char* s = nullptr;
  unsigned int err = ts3.getClientSelfVariableAsString(schid, flag, &s);
  return ts3String(err, s);
}
std::string serverString(uint64_t schid, size_t flag) {
  char* s = nullptr;
  unsigned int err = ts3.getServerVariableAsString(schid, flag, &s);
  return ts3String(err, s);
}
std::string channelString(uint64_t schid, uint64_t channel, size_t flag) {
  char* s = nullptr;
  unsigned int err = ts3.getChannelVariableAsString(schid, channel, flag, &s);
  return ts3String(err, s);
}
int selfInt(uint64_t schid, size_t flag) {
  int v = -1;
  return ts3.getClientSelfVariableAsInt(schid, flag, &v) == ERROR_ok ? v : -1;
}
std::string errorText(unsigned int err) {
  if (err == ERROR_ok) return std::string();
  char* s = nullptr;
  unsigned int e = ts3.getErrorMessage(err, &s);
  return ts3String(e, s);
}

const char* statusName(int st) {
  switch (st) {
    case STATUS_DISCONNECTED: return "disconnected";
    case STATUS_CONNECTING: return "connecting";
    case STATUS_CONNECTED: return "connected";
    case STATUS_CONNECTION_ESTABLISHING: return "establishing";
    case STATUS_CONNECTION_ESTABLISHED: return "established";
    default: return "unknown";
  }
}

std::string clientJson(anyID id, const ClientInfo& c) {
  return J().n("clientId", id).s("uid", c.uid).s("nickname", c.nickname).u("channelId", c.channelId).str();
}

// Looks up a client in TeamSpeak and caches it.
ClientInfo lookupClient(uint64_t schid, anyID id) {
  ClientInfo c;
  c.uid = clientString(schid, id, CLIENT_UNIQUE_IDENTIFIER);
  c.nickname = clientString(schid, id, CLIENT_NICKNAME);
  uint64_t ch = 0;
  if (ts3.getChannelOfClient(schid, id, &ch) == ERROR_ok) c.channelId = ch;
  if (!c.uid.empty()) {
    std::lock_guard<std::mutex> l(g_infoMu);
    g_clients[clientKey(schid, id)] = c;
  }
  return c;
}

// The whole state of one connection: status, server, our own client, its channel and who is in it.
void reportConnection(uint64_t schid, const char* reason, unsigned int error = ERROR_ok) {
  int status = STATUS_DISCONNECTED;
  ts3.getConnectionStatus(schid, &status);
  J ev;
  ev.s("type", "connection").u("schid", schid).s("reason", reason).n("status", status).s("statusName", statusName(status));
  if (error != ERROR_ok) ev.n("error", error).s("errorText", errorText(error));
  ConnInfo ci;
  {
    std::lock_guard<std::mutex> l(g_infoMu);
    ci = g_conns[schid];
  }
  std::string clients = "[]";
  if (status >= STATUS_CONNECTED) {
    anyID me = 0;
    uint64_t myChannel = 0;
    ts3.getClientID(schid, &me);
    ts3.getChannelOfClient(schid, me, &myChannel);
    ci.ownClientId = me;
    ci.ownChannelId = myChannel;
    const std::string serverUid = serverString(schid, VIRTUALSERVER_UNIQUE_IDENTIFIER);
    const std::string channelName = channelString(schid, myChannel, CHANNEL_NAME);
    {
      std::lock_guard<std::mutex> l(g_infoMu);
      g_conns[schid].ownClientId = me;
      g_conns[schid].ownChannelId = myChannel;
      g_conns[schid].serverUid = serverUid;
      g_conns[schid].channelName = channelName;
    }
    ev.raw("server", J().s("uid", serverUid).s("name", serverString(schid, VIRTUALSERVER_NAME)).s("host", ci.host).n("port", ci.port).str());
    ev.raw("self", J().n("clientId", me)
                       .s("uid", selfString(schid, CLIENT_UNIQUE_IDENTIFIER))
                       .s("nickname", selfString(schid, CLIENT_NICKNAME))
                       .n("inputMuted", selfInt(schid, CLIENT_INPUT_MUTED))
                       .n("inputDeactivated", selfInt(schid, CLIENT_INPUT_DEACTIVATED))
                       .n("outputMuted", selfInt(schid, CLIENT_OUTPUT_MUTED))
                       .n("recording", selfInt(schid, CLIENT_IS_RECORDING))
                       .str());
    ev.raw("channel", J().u("id", myChannel).s("name", channelName).str());
    if (status == STATUS_CONNECTION_ESTABLISHED && myChannel) {
      anyID* ids = nullptr;
      if (ts3.getChannelClientList(schid, myChannel, &ids) == ERROR_ok && ids) {
        clients = "[";
        bool first = true;
        for (anyID* p = ids; *p; p++) {
          if (*p == me) continue;
          ClientInfo c = lookupClient(schid, *p);
          if (c.uid.empty()) continue;
          int type = 0;
          ts3.getClientVariableAsInt(schid, *p, CLIENT_TYPE, &type);
          if (type != 0) continue;  // ServerQuery connections never talk
          clients += (first ? "" : ",") + clientJson(*p, c);
          first = false;
        }
        clients += "]";
        ts3.freeMemory(ids);
      }
    }
  }
  uint32_t fl = managedFlags(schid);
  ev.raw("managed", J().b("capture", fl & kCapture).b("listenOnly", fl & kListenOnly).b("suppressPlayback", fl & kSuppress).str());
  ev.raw("clients", clients);
  queueEvent(ev.str());
}

void reportAll(const char* reason) {
  uint64_t* ids = nullptr;
  if (ts3.getServerConnectionHandlerList(&ids) != ERROR_ok || !ids) return;
  for (uint64_t* p = ids; *p; p++) reportConnection(*p, reason);
  ts3.freeMemory(ids);
}

// Keeps a managed connection listen-only: microphone deactivated and muted (others see it muted).
// Never deafened: the playback callbacks must keep running.
void applyListenOnly(uint64_t schid) {
  bool changed = false;
  if (selfInt(schid, CLIENT_INPUT_DEACTIVATED) != INPUT_DEACTIVATED) {
    ts3.setClientSelfVariableAsInt(schid, CLIENT_INPUT_DEACTIVATED, INPUT_DEACTIVATED);
    changed = true;
  }
  if (selfInt(schid, CLIENT_INPUT_MUTED) != MUTEINPUT_MUTED) {
    ts3.setClientSelfVariableAsInt(schid, CLIENT_INPUT_MUTED, MUTEINPUT_MUTED);
    changed = true;
  }
  if (changed) ts3.flushClientSelfUpdates(schid, nullptr);
}

void applyRecording(uint64_t schid, bool on) {
  int now = selfInt(schid, CLIENT_IS_RECORDING);
  if (on && now != 1) ts3.startVoiceRecording(schid);
  if (!on && now == 1) ts3.stopVoiceRecording(schid);
}

// Settles a connection the plugin hasn't settled yet, once its channel is known (TeamSpeak's main
// thread: connected, a client moved, someone talked): in a remembered team channel it is listen-only and
// silent here until MatchFrame takes it over (not captured); elsewhere it is TeamSpeak's own (it plays).
void settle(uint64_t schid) {
  if (managedFlags(schid) || !g_anyRemembered.load()) return;
  int status = STATUS_DISCONNECTED;
  if (ts3.getConnectionStatus(schid, &status) != ERROR_ok || status != STATUS_CONNECTION_ESTABLISHED) return;
  anyID me = 0;
  uint64_t channel = 0;
  // Its channel not known yet (TeamSpeak can say established a moment before): still silent, settled later.
  if (ts3.getClientID(schid, &me) != ERROR_ok || !me || ts3.getChannelOfClient(schid, me, &channel) != ERROR_ok || !channel) return;
  const std::string channelName = channelString(schid, channel, CHANNEL_NAME);
  const std::string serverUid = serverString(schid, VIRTUALSERVER_UNIQUE_IDENTIFIER);
  if (channelName.empty() || serverUid.empty()) return;
  if (!isRemembered(serverUid, channelName)) {
    // On a team's server, just connected: probably on its way to the team channel (still silent).
    auto at = g_establishedUs.find(schid);
    if (isRememberedServer(serverUid) && (at == g_establishedUs.end() || mf::monoUs() - at->second < kSettleGraceUs)) return;
    setManaged(schid, kReleased);
    logLine("not a MatchFrame team tab (channel \"" + channelName + "\"): TeamSpeak's own, it plays here");
    return;
  }
  setManaged(schid, kListenOnly | kSuppress);
  applyListenOnly(schid);
  logLine("a remembered MatchFrame team tab connected: listen-only and silent until MatchFrame takes it over");
}

// ------------------------------------------------------------------------------------------------ sender
struct Bridge {
  uint16_t port = 0;
  std::string token;
};

bool readBridgeFile(Bridge& b) {
  std::string s = mf::readSmallFile(mf::bridgeFilePath(), 8192);
  if (s.empty()) return false;
  auto p = s.find("\"port\"");
  auto t = s.find("\"token\"");
  if (p == std::string::npos || t == std::string::npos) return false;
  p = s.find(':', p);
  if (p == std::string::npos) return false;
  long port = std::strtol(s.c_str() + p + 1, nullptr, 10);
  t = s.find('"', s.find(':', t));
  if (t == std::string::npos) return false;
  auto e = s.find('"', t + 1);
  if (e == std::string::npos || port < 1 || port > 65535) return false;
  b.port = static_cast<uint16_t>(port);
  b.token = s.substr(t + 1, e - t - 1);
  return !b.token.empty();
}

const char* platformName() {
#if defined(_WIN32)
  return "windows";
#elif defined(__APPLE__)
  return "mac";
#else
  return "linux";
#endif
}

void logLine(const std::string& msg, LogLevel level) {
  if (ts3.logMessage) ts3.logMessage(msg.c_str(), level, "MatchFrameComms", 0);
}

class Sender {
 public:
  void run() {
    mf::netInit();
    uint64_t nextAttempt = 0;
    while (g_running.load()) {
      if (sock_ == mf::kNoSocket) {
        discardQueued();
        uint64_t now = mf::monoUs();
        if (now >= nextAttempt) {
          if (!connectOnce()) nextAttempt = mf::monoUs() + backoffUs_;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        continue;
      }
      if (!step()) disconnect("connection to MatchFrame lost");
    }
    if (sock_ != mf::kNoSocket) disconnect("plugin unloading");
    mf::netDone();
  }

 private:
  mf::Socket sock_ = mf::kNoSocket;
  uint64_t backoffUs_ = 500000;
  std::vector<uint8_t> in_, out_;
  uint32_t seq_ = 0;
  uint64_t framesSent_ = 0, bytesSent_ = 0, discarded_ = 0, unknownClient_ = 0, otherChannel_ = 0, lookups_ = 0;
  size_t maxDepth_ = 0;
  uint64_t lastStatsUs_ = 0;

  void discardQueued() {
    while (g_queue->tryPop([](mf::AudioFrame&) {})) discarded_++;
    std::lock_guard<std::mutex> l(g_eventMu);
    g_events.clear();  // a full snapshot follows the next connection
  }

  bool connectOnce() {
    Bridge b;
    if (!readBridgeFile(b)) {
      backoffUs_ = 2000000;
      return false;
    }
    mf::Socket s = mf::connectLoopback(b.port, 1000);
    if (s == mf::kNoSocket) {
      backoffUs_ = std::min<uint64_t>(backoffUs_ * 2, 5000000);
      return false;
    }
    char* lib = nullptr;
    unsigned int libErr = ts3.getClientLibVersion(&lib);
    std::string libVersion = ts3String(libErr, lib);
    uint64_t libNum = 0;
    ts3.getClientLibVersionNumber(&libNum);
    std::string hello = J().s("token", b.token)
                            .n("protocol", kProtocol)
                            .s("instance", g_instance)
                            .raw("plugin", J().s("name", "MatchFrame Team Comms").s("version", MF_PLUGIN_VERSION).n("apiVersion", PLUGIN_API_VERSION_USED).str())
                            .raw("ts3", J().s("clientLibVersion", libVersion).u("clientLibVersionNumber", libNum).str())
                            .s("platform", platformName())
                            .raw("clock", J().u("nowUs", mf::monoUs()).str())
                            .raw("queue", J().u("capacity", g_queue->capacity()).u("maxFrameSamples", mf::kMaxFrameSamples).str())
                            .str();
    std::vector<uint8_t> msg;
    message(msg, kHello, hello);
    if (!mf::sendAll(s, msg.data(), msg.size())) {
      mf::closeSocket(s);
      return false;
    }
    // The answer: WELCOME, or ERROR and a closed connection.
    std::vector<uint8_t> buf;
    uint64_t until = mf::monoUs() + 3000000;
    while (mf::monoUs() < until) {
      int r = mf::waitReadable(s, 100);
      if (r < 0) break;
      if (r == 0) continue;
      uint8_t tmp[4096];
      long n = mf::recvSome(s, tmp, sizeof tmp);
      if (n <= 0) break;
      buf.insert(buf.end(), tmp, tmp + n);
      if (buf.size() < kHeader) continue;
      uint32_t len = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (static_cast<uint32_t>(buf[11]) << 24);
      if (buf.size() < kHeader + len) continue;
      if (std::memcmp(buf.data(), "MFTC", 4) != 0) break;
      if (buf[5] == kWelcome) {
        sock_ = s;
        backoffUs_ = 500000;
        in_.assign(buf.begin() + kHeader + len, buf.end());
        logLine("connected to MatchFrame on 127.0.0.1:" + std::to_string(b.port));
        reportAll("hello");
        return true;
      }
      if (buf[5] == kError) logLine("MatchFrame refused the plugin: " + std::string(buf.begin() + kHeader, buf.begin() + kHeader + len), LogLevel_WARNING);
      break;
    }
    mf::closeSocket(s);
    backoffUs_ = 5000000;
    return false;
  }

  void disconnect(const char* why) {
    mf::closeSocket(sock_);
    sock_ = mf::kNoSocket;
    in_.clear();
    logLine(why, LogLevel_WARNING);
    // Fail safe: nothing is captured until MatchFrame says so again; microphones stay off and the
    // tabs stay silent.
    for (auto& m : g_managed) m.flags.fetch_and(~static_cast<uint32_t>(kCapture));
  }

  bool step() {
    int r = mf::waitReadable(sock_, 2);
    if (r < 0) return false;
    if (r > 0) {
      uint8_t tmp[8192];
      long n = mf::recvSome(sock_, tmp, sizeof tmp);
      if (n <= 0) return false;
      in_.insert(in_.end(), tmp, tmp + n);
      if (!handleCommands()) return false;
    }
    out_.clear();
    bool overflowed = g_eventsOverflowed.exchange(false);
    {
      std::deque<std::string> evs;
      {
        std::lock_guard<std::mutex> l(g_eventMu);
        evs.swap(g_events);
      }
      for (auto& e : evs) message(out_, kEvent, e);
    }
    if (overflowed) reportAll("resync");
    maxDepth_ = std::max(maxDepth_, g_queue->depth());
    for (int i = 0; i < 512 && g_queue->tryPop([this](mf::AudioFrame& f) { appendAudio(f); }); i++) {
    }
    uint64_t now = mf::monoUs();
    if (now - lastStatsUs_ >= 1000000) {
      lastStatsUs_ = now;
      message(out_, kStats, statsJson(now));
    }
    if (out_.empty()) return true;
    bytesSent_ += out_.size();
    return mf::sendAll(sock_, out_.data(), out_.size());
  }

  void appendAudio(const mf::AudioFrame& f) {
    ClientInfo c;
    uint64_t ownChannel = 0;
    anyID me = 0;
    bool known = false;
    {
      std::lock_guard<std::mutex> l(g_infoMu);
      const uint64_t key = clientKey(f.schid, f.clientId);
      auto gone = g_departed.find(key);
      auto it = g_clients.find(key);
      if (gone != g_departed.end() && f.tUs <= gone->second.leftUs) {
        // Captured before they left: theirs, whoever has that session id now.
        c = gone->second.info;
        known = true;
      } else if (it != g_clients.end()) {
        c = it->second;
        known = true;
      }
      auto ci = g_conns.find(f.schid);
      if (ci != g_conns.end()) {
        ownChannel = ci->second.ownChannelId;
        me = ci->second.ownClientId;
      }
    }
    if (!known) {
      lookups_++;
      c = lookupClient(f.schid, f.clientId);
      if (c.uid.empty()) {
        unknownClient_++;
        return;
      }
      // Ahead of this block (not queued behind it): MatchFrame takes audio only from people it knows are in the channel.
      message(out_, kEvent, J().s("type", "client").u("schid", f.schid).s("change", "discovered").raw("client", clientJson(f.clientId, c)).str());
    }
    // Only the team's own channel: a whisper from elsewhere is not the team's comms.
    if (ownChannel && c.channelId != ownChannel) {
      otherChannel_++;
      return;
    }
    const uint32_t pcmBytes = f.frames * f.channels * 2;
    const uint8_t uidLen = static_cast<uint8_t>(std::min<size_t>(c.uid.size(), 255));
    header(out_, kAudio, 40 + uidLen + pcmBytes);
    put64(out_, f.schid);
    put64(out_, f.tUs);
    put32(out_, seq_++);
    put32(out_, kPlaybackRate);
    put32(out_, f.frames);
    put16(out_, f.clientId);
    put16(out_, me);
    out_.push_back(f.channels);
    out_.push_back(1);  // 16-bit signed little-endian samples
    out_.push_back(f.part);
    out_.push_back(uidLen);
    put32(out_, 0);
    out_.insert(out_.end(), c.uid.begin(), c.uid.begin() + uidLen);
    const uint8_t* pcm = reinterpret_cast<const uint8_t*>(f.pcm);
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    for (uint32_t i = 0; i < f.frames * f.channels; i++) put16(out_, static_cast<uint16_t>(f.pcm[i]));
    (void)pcm;
#else
    out_.insert(out_.end(), pcm, pcm + pcmBytes);
#endif
    framesSent_++;
  }

  std::string statsJson(uint64_t now) {
    std::string conns = "[";
    bool first = true;
    for (auto& s : g_cb) {
      uint64_t id = s.schid.load();
      if (!id) continue;
      conns += (first ? "" : ",") + J().u("schid", id)
                                        .u("voiceCalls", s.voiceCalls.load())
                                        .u("voiceSamples", s.voiceSamples.load())
                                        .u("captured", s.captured.load())
                                        .u("dropped", s.dropped.load())
                                        .u("zeroed", s.zeroed.load())
                                        .u("badFormat", s.badFormat.load())
                                        .u("mixedCalls", s.mixedCalls.load())
                                        .u("mixedNonSilent", s.mixedNonSilent.load())
                                        .u("mixedZeroed", s.mixedZeroed.load())
                                        .u("capturedSendBlocked", s.capturedSendBlocked.load())
                                        .n("lastChannels", s.lastChannels.load())
                                        .n("lastSampleCount", s.lastSampleCount.load())
                                        .n("managed", managedFlags(id))
                                        .str();
      first = false;
    }
    conns += "]";
    size_t depth = g_queue->depth();
    std::string st = J().s("type", "stats")
                         .u("tUs", now)
                         .raw("queue", J().u("capacity", g_queue->capacity()).u("depth", depth).u("maxDepth", maxDepth_).u("dropped", g_queueDropped.load()).str())
                         .raw("sent", J().u("frames", framesSent_).u("bytes", bytesSent_).str())
                         .u("discardedOffline", discarded_)
                         .u("unknownClient", unknownClient_)
                         .u("otherChannel", otherChannel_)
                         .u("identityLookups", lookups_)
                         .b("recording", g_recording.load())
                         .raw("connections", conns)
                         .str();
    maxDepth_ = depth;
    return st;
  }

  bool handleCommands() {
    while (in_.size() >= kHeader) {
      if (std::memcmp(in_.data(), "MFTC", 4) != 0 || in_[4] != kProtocol) return false;
      uint32_t len = in_[8] | (in_[9] << 8) | (in_[10] << 16) | (static_cast<uint32_t>(in_[11]) << 24);
      if (len > kMaxPayload) return false;
      if (in_.size() < kHeader + len) return true;
      const uint8_t type = in_[5];
      const uint8_t* p = in_.data() + kHeader;
      if (type == kManage && len >= 12) {
        uint64_t schid = get64(p);
        uint32_t flags = (p[8] ? uint32_t(kCapture) : 0u) | (p[9] ? uint32_t(kListenOnly) : 0u) | (p[10] ? uint32_t(kSuppress) : 0u);
        // Handed back by MatchFrame: TeamSpeak's own, playing (not an unsettled connection).
        setManaged(schid, flags ? flags : uint32_t(kReleased));
        if (flags & kListenOnly) applyListenOnly(schid);
        if (flags) applyRecording(schid, g_recording.load());
        reportConnection(schid, "managed");
        // Captured: a team tab, remembered for a TeamSpeak restart. Released (no flags): forgotten.
        if (flags == 0 || (flags & kCapture)) {
          std::string server, channel, host;
          unsigned short port = 0;
          {
            std::lock_guard<std::mutex> l(g_infoMu);
            auto ci = g_conns.find(schid);
            if (ci != g_conns.end()) {
              server = ci->second.serverUid;
              channel = ci->second.channelName;
              host = ci->second.host;
              port = ci->second.port;
            }
          }
          remember(server, channel, host, port, flags != 0);
        }
      } else if (type == kRecording && len >= 1) {
        g_recording = p[0] != 0;
        for (auto& m : g_managed) {
          uint64_t id = m.schid.load();
          if (id && (m.flags.load() & kOurs)) applyRecording(id, g_recording.load());
        }
      } else if (type == kSnapshot) {
        reportAll("snapshot");
      } else if (type == kPing && len >= 8) {
        std::vector<uint8_t> pong;
        header(pong, kPong, 16);
        put64(pong, get64(p));
        put64(pong, mf::monoUs());
        if (!mf::sendAll(sock_, pong.data(), pong.size())) return false;
      } else if (type == kError) {
        logLine("MatchFrame: " + std::string(p, p + len), LogLevel_WARNING);
      }
      in_.erase(in_.begin(), in_.begin() + kHeader + len);
    }
    return true;
  }
};

}  // namespace

// ------------------------------------------------------------------------------------------------ required exports
MF_EXPORT const char* ts3plugin_name() { return "MatchFrame Team Comms"; }
MF_EXPORT const char* ts3plugin_version() { return MF_PLUGIN_VERSION; }
MF_EXPORT int ts3plugin_apiVersion() { return PLUGIN_API_VERSION_USED; }
MF_EXPORT const char* ts3plugin_author() { return "MatchFrame Esports"; }
MF_EXPORT const char* ts3plugin_description() {
  return "Sends each team member's voice, separately, to MatchFrame Esports on this computer (127.0.0.1) for a delayed broadcast and recording. "
         "Only the connections MatchFrame manages are captured; their microphones are kept off and their sound is not played here.";
}
MF_EXPORT void ts3plugin_setFunctionPointers(const struct TS3Functions funcs) { ts3 = funcs; }

MF_EXPORT int ts3plugin_init() {
  {
    std::random_device rd;
    char id[40];
    std::snprintf(id, sizeof id, "%08x%08x%08x", rd(), rd(), static_cast<unsigned>(mf::monoUs()));
    g_instance = id;
  }
  {
    g_rememberFile = mf::envStr("MATCHFRAME_COMMS_TABS_FILE");
    if (g_rememberFile.empty() && ts3.getConfigPath) {
      char dir[1024] = "";
      ts3.getConfigPath(dir, sizeof dir);
      std::string d(dir);
      if (!d.empty()) {
        if (d.back() != '/' && d.back() != '\\') d += mf::kPathSep;
        g_rememberFile = d + "matchframe_comms_tabs.txt";
      }
    }
    loadRemembered();
    {
      std::lock_guard<std::mutex> l(g_rememberMu);
      if (!g_remembered.empty()) logLine(std::to_string(g_remembered.size()) + " MatchFrame team tab(s) remembered: connections are silent here until their channel is known");
    }
  }
  g_queue.reset(new mf::FrameQueue(1024));
  g_running = true;
  g_sender = std::thread([] { Sender().run(); });
  return 0;
}

MF_EXPORT void ts3plugin_shutdown() {
  g_running = false;
  if (g_sender.joinable()) g_sender.join();
  for (auto& m : g_managed) {
    uint64_t id = m.schid.load();
    if (id && (m.flags.load() & kOurs)) applyRecording(id, false);
  }
  g_queue.reset();
  if (g_pluginId) {
    free(g_pluginId);
    g_pluginId = nullptr;
  }
}

// ------------------------------------------------------------------------------------------------ optional exports
MF_EXPORT int ts3plugin_offersConfigure() { return PLUGIN_OFFERS_NO_CONFIGURE; }
MF_EXPORT void ts3plugin_registerPluginID(const char* id) {
  size_t n = std::strlen(id) + 1;
  g_pluginId = static_cast<char*>(malloc(n));
  if (g_pluginId) std::memcpy(g_pluginId, id, n);
}
MF_EXPORT void ts3plugin_freeMemory(void* data) { free(data); }
MF_EXPORT int ts3plugin_requestAutoload() { return 1; }

// ------------------------------------------------------------------------------------------------ connection and client events (main thread)
MF_EXPORT void ts3plugin_onConnectStatusChangeEvent(uint64 schid, int newStatus, unsigned int errorNumber) {
  if (newStatus == STATUS_CONNECTION_ESTABLISHED) {
    char host[512] = "";
    unsigned short port = 0;
    if (ts3.getServerConnectInfo && ts3.getServerConnectInfo(schid, host, &port, nullptr, sizeof host) == ERROR_ok) {
      std::lock_guard<std::mutex> l(g_infoMu);
      g_conns[schid].host = host;
      g_conns[schid].port = port;
    }
    g_establishedUs[schid] = mf::monoUs();
    settle(schid);
    uint32_t fl = managedFlags(schid);
    if (fl & kListenOnly) applyListenOnly(schid);
    if (fl & kOurs) applyRecording(schid, g_recording.load());
  }
  // Released (not a team tab): unsettled again for its next connection.
  if (newStatus == STATUS_DISCONNECTED) {
    g_establishedUs.erase(schid);
    if (managedFlags(schid) == kReleased) setManaged(schid, 0);
  }
  if (newStatus == STATUS_DISCONNECTED) {
    std::lock_guard<std::mutex> l(g_infoMu);
    for (auto it = g_clients.begin(); it != g_clients.end();) it = (it->first >> 16) == schid ? g_clients.erase(it) : std::next(it);
    g_conns[schid].ownChannelId = 0;
    g_conns[schid].ownClientId = 0;
  }
  // A reconnected tab is captured again only once MatchFrame has checked it is still the team's.
  if (newStatus == STATUS_DISCONNECTED || newStatus == STATUS_CONNECTING) clearManagedBits(schid, kCapture);
  reportConnection(schid, "status", errorNumber);
}

namespace {
void clientMoved(uint64 schid, anyID clientID, uint64 oldChannelID, uint64 newChannelID) {
  // Not settled yet: as soon as the tab's own channel is known.
  if (!managedFlags(schid)) settle(schid);
  anyID me = 0;
  uint64_t mine = 0;
  {
    std::lock_guard<std::mutex> l(g_infoMu);
    auto it = g_conns.find(schid);
    if (it != g_conns.end()) {
      me = it->second.ownClientId;
      mine = it->second.ownChannelId;
    }
  }
  if (clientID == me && me != 0) {
    // Our own client moved: a released tab may now be in a team channel, and the reverse.
    if (managedFlags(schid) == kReleased) setManaged(schid, 0);
    settle(schid);
    reportConnection(schid, "moved");
    return;
  }
  if (newChannelID != 0 && newChannelID == mine) {
    ClientInfo c = lookupClient(schid, clientID);
    c.channelId = newChannelID;
    {
      std::lock_guard<std::mutex> l(g_infoMu);
      g_clients[clientKey(schid, clientID)].channelId = newChannelID;
    }
    queueEvent(J().s("type", "client").u("schid", schid).s("change", "enter").raw("client", clientJson(clientID, c)).str());
    return;
  }
  ClientInfo c;
  {
    std::lock_guard<std::mutex> l(g_infoMu);
    auto it = g_clients.find(clientKey(schid, clientID));
    if (it != g_clients.end()) {
      c = it->second;
      if (oldChannelID != 0 && oldChannelID == mine) noteDeparted(it->first, c, oldChannelID);
      if (newChannelID == 0)
        g_clients.erase(it);
      else
        it->second.channelId = newChannelID;
    }
  }
  if (oldChannelID != 0 && oldChannelID == mine) {
    c.channelId = newChannelID;
    queueEvent(J().s("type", "client").u("schid", schid).s("change", "leave").raw("client", clientJson(clientID, c)).str());
  }
}
}  // namespace

MF_EXPORT void ts3plugin_onClientMoveEvent(uint64 schid, anyID clientID, uint64 oldChannelID, uint64 newChannelID, int, const char*) { clientMoved(schid, clientID, oldChannelID, newChannelID); }
MF_EXPORT void ts3plugin_onClientMoveSubscriptionEvent(uint64 schid, anyID clientID, uint64 oldChannelID, uint64 newChannelID, int) { clientMoved(schid, clientID, oldChannelID, newChannelID); }
MF_EXPORT void ts3plugin_onClientMoveTimeoutEvent(uint64 schid, anyID clientID, uint64 oldChannelID, uint64 newChannelID, int, const char*) { clientMoved(schid, clientID, oldChannelID, newChannelID); }
MF_EXPORT void ts3plugin_onClientMoveMovedEvent(uint64 schid, anyID clientID, uint64 oldChannelID, uint64 newChannelID, int, anyID, const char*, const char*, const char*) { clientMoved(schid, clientID, oldChannelID, newChannelID); }
MF_EXPORT void ts3plugin_onClientKickFromChannelEvent(uint64 schid, anyID clientID, uint64 oldChannelID, uint64 newChannelID, int, anyID, const char*, const char*, const char*) { clientMoved(schid, clientID, oldChannelID, newChannelID); }
MF_EXPORT void ts3plugin_onClientKickFromServerEvent(uint64 schid, anyID clientID, uint64 oldChannelID, uint64 newChannelID, int, anyID, const char*, const char*, const char*) { clientMoved(schid, clientID, oldChannelID, newChannelID); }

MF_EXPORT void ts3plugin_onClientDisplayNameChanged(uint64 schid, anyID clientID, const char* displayName, const char* uid) {
  ClientInfo c;
  bool inChannel = false;
  {
    std::lock_guard<std::mutex> l(g_infoMu);
    auto it = g_clients.find(clientKey(schid, clientID));
    if (it == g_clients.end()) return;
    it->second.nickname = displayName ? displayName : "";
    if (uid && *uid) it->second.uid = uid;
    c = it->second;
    auto ci = g_conns.find(schid);
    inChannel = ci != g_conns.end() && ci->second.ownChannelId == c.channelId;
  }
  if (inChannel) queueEvent(J().s("type", "client").u("schid", schid).s("change", "update").raw("client", clientJson(clientID, c)).str());
}

MF_EXPORT void ts3plugin_onTalkStatusChangeEvent(uint64 schid, int status, int isReceivedWhisper, anyID clientID) {
  // Receive-time talking (TeamSpeak's own indicator): shown as incoming activity only. MatchFrame's
  // delayed activity comes from the audio itself.
  if (!managedFlags(schid)) settle(schid);
  if (!(managedFlags(schid) & kOurs)) return;
  queueEvent(J().s("type", "talk").u("schid", schid).n("clientId", clientID).n("talking", status).n("whisper", isReceivedWhisper).u("tUs", mf::monoUs()).str());
}

// TeamSpeak's refusals (identity already connected, flood prevention, wrong password, banned...): what
// the operator must fix, shown by MatchFrame next to the team. Returning 0 lets TeamSpeak show it too.
MF_EXPORT int ts3plugin_onServerErrorEvent(uint64 schid, const char* errorMessage, unsigned int error, const char*, const char* extraMessage) {
  if (error == ERROR_ok) return 0;
  queueEvent(J().s("type", "error").u("schid", schid).n("error", error).s("message", errorMessage ? errorMessage : "").s("extra", extraMessage ? extraMessage : "").u("tUs", mf::monoUs()).str());
  return 0;
}

MF_EXPORT void ts3plugin_onClientSelfVariableUpdateEvent(uint64 schid, int flag, const char* oldValue, const char* newValue) {
  if (flag != CLIENT_INPUT_MUTED && flag != CLIENT_INPUT_DEACTIVATED && flag != CLIENT_OUTPUT_MUTED && flag != CLIENT_IS_RECORDING) return;
  uint32_t fl = managedFlags(schid);
  if (!(fl & kOurs)) return;
  queueEvent(J().s("type", "self").u("schid", schid).n("flag", flag).s("old", oldValue ? oldValue : "").s("new", newValue ? newValue : "").str());
  // Someone switched the microphone back on in a team's tab: off again (it is a listener).
  if ((fl & kListenOnly) && (flag == CLIENT_INPUT_MUTED || flag == CLIENT_INPUT_DEACTIVATED) && newValue && std::strcmp(newValue, "0") == 0) applyListenOnly(schid);
  reportConnection(schid, "self");
}

// ------------------------------------------------------------------------------------------------ audio (TeamSpeak's playback thread)
MF_EXPORT void ts3plugin_onEditPlaybackVoiceDataEvent(uint64 schid, anyID clientID, short* samples, int sampleCount, int channels) {
  CallbackStats* st = statsFor(schid);
  if (st) {
    st->voiceCalls.fetch_add(1, std::memory_order_relaxed);
    st->voiceSamples.fetch_add(static_cast<uint64_t>(sampleCount > 0 ? sampleCount : 0), std::memory_order_relaxed);
    st->lastChannels.store(channels, std::memory_order_relaxed);
    st->lastSampleCount.store(sampleCount, std::memory_order_relaxed);
  }
  const uint32_t fl = managedFlags(schid);
  // Not settled yet while team tabs are remembered: silent here (never captured).
  const bool unsettled = fl == 0 && g_anyRemembered.load(std::memory_order_relaxed);
  if ((!fl && !unsettled) || !samples || sampleCount <= 0) return;
  if (channels < 1 || channels > 2) {
    if (st) st->badFormat.fetch_add(1, std::memory_order_relaxed);
  } else if ((fl & kCapture) && g_queue) {
    const uint64_t t = mf::monoUs();
    const int perFrame = static_cast<int>(mf::kMaxFrameSamples) / channels;
    uint8_t part = 0;
    for (int off = 0; off < sampleCount; off += perFrame, part++) {
      const int n = std::min(perFrame, sampleCount - off);
      const bool ok = g_queue->tryPush([&](mf::AudioFrame& f) {
        f.schid = schid;
        f.tUs = t + static_cast<uint64_t>(off) * 1000000ull / kPlaybackRate;
        f.frames = static_cast<uint32_t>(n);
        f.clientId = clientID;
        f.channels = static_cast<uint8_t>(channels);
        f.part = part;
        std::memcpy(f.pcm, samples + static_cast<size_t>(off) * channels, static_cast<size_t>(n) * channels * sizeof(short));
      });
      if (st) (ok ? st->captured : st->dropped).fetch_add(1, std::memory_order_relaxed);
      if (!ok) g_queueDropped.fetch_add(1, std::memory_order_relaxed);
    }
  }
  // Silent here: the team's voices never reach this computer's speakers (or a desktop capture).
  if (((fl & kSuppress) || unsettled) && channels >= 1 && channels <= 8) {
    std::memset(samples, 0, static_cast<size_t>(sampleCount) * channels * sizeof(short));
    if (st) st->zeroed.fetch_add(1, std::memory_order_relaxed);
  }
}

MF_EXPORT void ts3plugin_onEditMixedPlaybackVoiceDataEvent(uint64 schid, short* samples, int sampleCount, int channels, const unsigned int*, unsigned int*) {
  CallbackStats* st = statsFor(schid);
  if (st) st->mixedCalls.fetch_add(1, std::memory_order_relaxed);
  const uint32_t fl = managedFlags(schid);
  const bool unsettled = fl == 0 && g_anyRemembered.load(std::memory_order_relaxed);
  if (!((fl & kSuppress) || unsettled) || !samples || sampleCount <= 0 || channels < 1 || channels > 8) return;
  const size_t n = static_cast<size_t>(sampleCount) * channels;
  bool nonSilent = false;
  for (size_t i = 0; i < n && !nonSilent; i++) nonSilent = samples[i] != 0;
  if (st && nonSilent) st->mixedNonSilent.fetch_add(1, std::memory_order_relaxed);
  // Everything else this tab would play (TeamSpeak's own sounds) is silenced too.
  std::memset(samples, 0, n * sizeof(short));
  if (st) st->mixedZeroed.fetch_add(1, std::memory_order_relaxed);
}

MF_EXPORT void ts3plugin_onEditCapturedVoiceDataEvent(uint64 schid, short* samples, int sampleCount, int channels, int* edited) {
  // A listener never transmits, even if its microphone were switched on before MatchFrame sees it.
  const uint32_t fl = managedFlags(schid);
  if (!(fl & kListenOnly) || !edited) return;
  if (samples && sampleCount > 0 && channels > 0 && channels <= 8) std::memset(samples, 0, static_cast<size_t>(sampleCount) * channels * sizeof(short));
  if (*edited & 2) {
    CallbackStats* st = statsFor(schid);
    if (st) st->capturedSendBlocked.fetch_add(1, std::memory_order_relaxed);
  }
  *edited = (*edited | 1) & ~2;
}
