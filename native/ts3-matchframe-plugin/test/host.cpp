// A stand-in TeamSpeak 3 client for testing the real plugin binary without TeamSpeak: it loads the
// compiled plugin, gives it stub client functions (two tabs, Team Alpha and Team Bravo, three people
// each), and calls its callbacks as TeamSpeak does: connection events on this (main) thread, voice
// on one audio thread per tab (360 samples every 7.5 ms, as measured in TeamSpeak 3.6.2). It prints
// one JSON line: what the plugin did to the samples, the microphone and the recording status.
//
//   host <plugin.so|.dll> <seconds>       (the bridge file comes from MATCHFRAME_COMMS_BRIDGE_FILE)
//
// Builds for Linux (g++) and Windows (MSVC or mingw-w64; run under Wine on Linux to test the
// Windows plugin's sockets, clock and paths). Not evidence of TeamSpeak capture: the TeamSpeak
// side is simulated.
#define _USE_MATH_DEFINES
#if defined(_WIN32)
#include <windows.h>
#define LIB_OPEN(p) LoadLibraryA(p)
#define LIB_SYM(h, n) reinterpret_cast<void*>(GetProcAddress(static_cast<HMODULE>(h), n))
#define LIB_CLOSE(h) FreeLibrary(static_cast<HMODULE>(h))
#define LIB_ERROR() "LoadLibrary failed"
#else
#include <dlfcn.h>
#define LIB_OPEN(p) dlopen(p, RTLD_NOW | RTLD_LOCAL)
#define LIB_SYM(h, n) dlsym(h, n)
#define LIB_CLOSE(h) dlclose(h)
#define LIB_ERROR() dlerror()
#endif

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "plugin_definitions.h"
#include "teamspeak/public_definitions.h"
#include "teamspeak/public_errors.h"
#include "teamspeak/public_rare_definitions.h"
#include "ts3_functions.h"

namespace {

struct Person {
  anyID id;
  const char* uid;
  const char* nick;
  double freq;
};
struct Tab {
  uint64 schid;
  uint64 channel;
  const char* channelName;
  anyID self;
  const char* selfNick;
  std::vector<Person> people;
};

std::mutex mu;
std::vector<Tab> tabs = {
    {1, 11, "Team Alpha", 2, "MF Listener A", {{10, "hostA1uidAAAAAAAAAAAAAAAAAAA=", "Alpha 1", 330}, {11, "hostA2uidAAAAAAAAAAAAAAAAAAA=", "Alpha 2", 470}, {12, "hostA3uidAAAAAAAAAAAAAAAAAAA=", "Alpha 3", 610}}},
    {2, 12, "Team Bravo", 3, "MF Listener B", {{20, "hostB1uidBBBBBBBBBBBBBBBBBBB=", "Bravo 1", 1310}, {21, "hostB2uidBBBBBBBBBBBBBBBBBBB=", "Bravo 2", 1450}, {22, "hostB3uidBBBBBBBBBBBBBBBBBBB=", "Bravo 3", 1590}}},
};
const char* kListenerUid = "hostListenerUidXXXXXXXXXXXX=";
std::map<std::pair<uint64, size_t>, int> selfInts;
std::vector<std::string> calls;

Tab* tabOf(uint64 schid) {
  for (auto& t : tabs)
    if (t.schid == schid) return &t;
  return nullptr;
}
char* dup(const char* s) { return strdup(s); }
void note(const std::string& c) {
  std::lock_guard<std::mutex> l(mu);
  calls.push_back(c);
}

unsigned int getClientLibVersion(char** r) { *r = dup("3.6.2 [stand-in host]"); return ERROR_ok; }
unsigned int getClientLibVersionNumber(uint64* r) { *r = 1695203293; return ERROR_ok; }
unsigned int freeMemory(void* p) { free(p); return ERROR_ok; }
unsigned int logMessage(const char* m, enum LogLevel, const char* ch, uint64) { std::fprintf(stderr, "[%s] %s\n", ch, m); return ERROR_ok; }
unsigned int getErrorMessage(unsigned int, char** r) { *r = dup("stand-in error"); return ERROR_ok; }
unsigned int getConnectionStatus(uint64 schid, int* r) { *r = tabOf(schid) ? STATUS_CONNECTION_ESTABLISHED : STATUS_DISCONNECTED; return ERROR_ok; }
unsigned int getClientID(uint64 schid, anyID* r) { Tab* t = tabOf(schid); if (!t) return ERROR_not_connected; *r = t->self; return ERROR_ok; }
unsigned int getChannelOfClient(uint64 schid, anyID, uint64* r) { Tab* t = tabOf(schid); if (!t) return ERROR_not_connected; *r = t->channel; return ERROR_ok; }
unsigned int getServerVariableAsString(uint64, size_t flag, char** r) { *r = dup(flag == VIRTUALSERVER_UNIQUE_IDENTIFIER ? "hostServerUid=" : "Stand-in server"); return ERROR_ok; }
unsigned int getClientSelfVariableAsString(uint64 schid, size_t flag, char** r) {
  Tab* t = tabOf(schid);
  *r = dup(flag == CLIENT_UNIQUE_IDENTIFIER ? kListenerUid : (t ? t->selfNick : "?"));
  return ERROR_ok;
}
unsigned int getClientSelfVariableAsInt(uint64 schid, size_t flag, int* r) {
  std::lock_guard<std::mutex> l(mu);
  *r = selfInts[{schid, flag}];
  return ERROR_ok;
}
unsigned int setClientSelfVariableAsInt(uint64 schid, size_t flag, int v) {
  { std::lock_guard<std::mutex> l(mu); selfInts[{schid, flag}] = v; }
  note("set " + std::to_string(schid) + " " + (flag == CLIENT_INPUT_DEACTIVATED ? "inputDeactivated" : flag == CLIENT_INPUT_MUTED ? "inputMuted" : std::to_string(flag)) + "=" + std::to_string(v));
  return ERROR_ok;
}
unsigned int flushClientSelfUpdates(uint64 schid, const char*) { note("flush " + std::to_string(schid)); return ERROR_ok; }
unsigned int getChannelVariableAsString(uint64 schid, uint64, size_t, char** r) { Tab* t = tabOf(schid); *r = dup(t ? t->channelName : ""); return ERROR_ok; }
unsigned int getChannelClientList(uint64 schid, uint64, anyID** r) {
  Tab* t = tabOf(schid);
  if (!t) return ERROR_not_connected;
  std::lock_guard<std::mutex> l(mu);
  anyID* a = static_cast<anyID*>(malloc(sizeof(anyID) * (t->people.size() + 2)));
  size_t n = 0;
  a[n++] = t->self;
  for (auto& p : t->people) a[n++] = p.id;
  a[n] = 0;
  *r = a;
  return ERROR_ok;
}
unsigned int getClientVariableAsString(uint64 schid, anyID id, size_t flag, char** r) {
  Tab* t = tabOf(schid);
  if (!t) return ERROR_not_connected;
  std::lock_guard<std::mutex> l(mu);
  for (auto& p : t->people)
    if (p.id == id) {
      *r = dup(flag == CLIENT_UNIQUE_IDENTIFIER ? p.uid : p.nick);
      return ERROR_ok;
    }
  if (id == t->self) { *r = dup(flag == CLIENT_UNIQUE_IDENTIFIER ? kListenerUid : t->selfNick); return ERROR_ok; }
  return ERROR_client_invalid_id;
}
unsigned int getClientVariableAsInt(uint64, anyID, size_t, int* r) { *r = 0; return ERROR_ok; }
unsigned int getServerConnectionHandlerList(uint64** r) {
  uint64* a = static_cast<uint64*>(malloc(sizeof(uint64) * 3));
  a[0] = 1; a[1] = 2; a[2] = 0;
  *r = a;
  return ERROR_ok;
}
unsigned int getServerConnectInfo(uint64, char* host, unsigned short* port, char*, size_t maxLen) {
  std::snprintf(host, maxLen, "%s", "ts.example.org");
  *port = 9987;
  return ERROR_ok;
}
unsigned int startVoiceRecording(uint64 schid) { { std::lock_guard<std::mutex> l(mu); selfInts[{schid, CLIENT_IS_RECORDING}] = 1; } note("startVoiceRecording " + std::to_string(schid)); return ERROR_ok; }
unsigned int stopVoiceRecording(uint64 schid) { { std::lock_guard<std::mutex> l(mu); selfInts[{schid, CLIENT_IS_RECORDING}] = 0; } note("stopVoiceRecording " + std::to_string(schid)); return ERROR_ok; }

template <typename T>
T sym(void* h, const char* name) {
  void* p = LIB_SYM(h, name);
  if (!p) {
    std::fprintf(stderr, "missing export %s\n", name);
    std::exit(2);
  }
  return reinterpret_cast<T>(p);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) return 2;
  void* h = reinterpret_cast<void*>(LIB_OPEN(argv[1]));
  if (!h) {
    std::fprintf(stderr, "cannot load %s: %s\n", argv[1], LIB_ERROR());
    return 2;
  }
  const double seconds = std::atof(argv[2]);
  auto apiVersion = sym<int (*)()>(h, "ts3plugin_apiVersion");
  auto setFns = sym<void (*)(const TS3Functions)>(h, "ts3plugin_setFunctionPointers");
  auto init = sym<int (*)()>(h, "ts3plugin_init");
  auto shutdown = sym<void (*)()>(h, "ts3plugin_shutdown");
  auto status = sym<void (*)(uint64, int, unsigned int)>(h, "ts3plugin_onConnectStatusChangeEvent");
  auto voice = sym<void (*)(uint64, anyID, short*, int, int)>(h, "ts3plugin_onEditPlaybackVoiceDataEvent");
  auto mixed = sym<void (*)(uint64, short*, int, int, const unsigned int*, unsigned int*)>(h, "ts3plugin_onEditMixedPlaybackVoiceDataEvent");
  auto captured = sym<void (*)(uint64, short*, int, int, int*)>(h, "ts3plugin_onEditCapturedVoiceDataEvent");
  auto move = sym<void (*)(uint64, anyID, uint64, uint64, int, const char*)>(h, "ts3plugin_onClientMoveEvent");
  for (const char* req : {"ts3plugin_name", "ts3plugin_version", "ts3plugin_author", "ts3plugin_description"}) sym<void*>(h, req);

  TS3Functions f{};
  f.getClientLibVersion = getClientLibVersion;
  f.getClientLibVersionNumber = getClientLibVersionNumber;
  f.freeMemory = freeMemory;
  f.logMessage = logMessage;
  f.getErrorMessage = getErrorMessage;
  f.getConnectionStatus = getConnectionStatus;
  f.getClientID = getClientID;
  f.getChannelOfClient = getChannelOfClient;
  f.getServerVariableAsString = getServerVariableAsString;
  f.getClientSelfVariableAsString = getClientSelfVariableAsString;
  f.getClientSelfVariableAsInt = getClientSelfVariableAsInt;
  f.setClientSelfVariableAsInt = setClientSelfVariableAsInt;
  f.flushClientSelfUpdates = flushClientSelfUpdates;
  f.getChannelVariableAsString = getChannelVariableAsString;
  f.getChannelClientList = getChannelClientList;
  f.getClientVariableAsString = getClientVariableAsString;
  f.getClientVariableAsInt = getClientVariableAsInt;
  f.getServerConnectionHandlerList = getServerConnectionHandlerList;
  f.getServerConnectInfo = getServerConnectInfo;
  f.startVoiceRecording = startVoiceRecording;
  f.stopVoiceRecording = stopVoiceRecording;
  setFns(f);
  if (init() != 0) return 3;
  for (auto& t : tabs) status(t.schid, STATUS_CONNECTION_ESTABLISHED, ERROR_ok);

  std::atomic<bool> run{true};
  std::atomic<long> voiceCalls{0}, zeroed{0}, untouched{0}, mixedZeroed{0}, mixedCalls{0}, sendBlocked{0};
  auto start = std::chrono::steady_clock::now();
  std::vector<std::thread> audio;
  for (auto& tab : tabs) {
    audio.emplace_back([&, schid = tab.schid] {
      long n = 0;
      auto next = std::chrono::steady_clock::now();
      while (run.load()) {
        std::vector<Person> people;
        {
          std::lock_guard<std::mutex> l(mu);
          people = tabOf(schid)->people;
        }
        // Everyone talks at once: each person's own tone, 360 samples (7.5 ms) a call.
        for (auto& p : people) {
          short s[360];
          for (int i = 0; i < 360; i++) s[i] = static_cast<short>(std::lround(8000 * std::sin(2 * M_PI * p.freq * (n * 360 + i) / 48000.0)));
          voice(schid, p.id, s, 360, 1);
          bool allZero = true;
          for (short v : s) allZero = allZero && v == 0;
          voiceCalls++;
          (allZero ? zeroed : untouched)++;
        }
        short mix[720];
        for (int i = 0; i < 720; i++) mix[i] = 1000;
        unsigned int mask = 3;
        const unsigned int speakers[2] = {1, 2};
        mixed(schid, mix, 360, 2, speakers, &mask);
        mixedCalls++;
        if (mix[0] == 0 && mix[719] == 0) mixedZeroed++;
        // A microphone block: a listener never sends it.
        short mic[360] = {1};
        int edited = 2;
        captured(schid, mic, 360, 1, &edited);
        if (!(edited & 2)) sendBlocked++;
        n++;
        next += std::chrono::microseconds(7500);
        std::this_thread::sleep_until(next);
      }
    });
  }
  // Halfway: Alpha 2 reconnects with a new session id (same identity).
  std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<int>(seconds * 500)));
  {
    std::lock_guard<std::mutex> l(mu);
    tabOf(1)->people[1].id = 15;
  }
  move(1, 11, 11, 0, 0, "");
  move(1, 15, 0, 11, 0, "");
  std::this_thread::sleep_until(start + std::chrono::milliseconds(static_cast<int>(seconds * 1000)));
  run = false;
  for (auto& t : audio) t.join();
  shutdown();
  const int api = apiVersion();
  LIB_CLOSE(h);
  std::string list;
  {
    std::lock_guard<std::mutex> l(mu);
    for (auto& c : calls) list += (list.empty() ? "\"" : ",\"") + c + "\"";
  }
  std::fflush(stderr);
  std::printf("{\"apiVersion\":%d,\"voiceCalls\":%ld,\"zeroed\":%ld,\"untouched\":%ld,\"mixedCalls\":%ld,\"mixedZeroed\":%ld,\"micBlocked\":%ld,\"calls\":[%s]}\n", api, voiceCalls.load(), zeroed.load(), untouched.load(), mixedCalls.load(), mixedZeroed.load(), sendBlocked.load(), list.c_str());
  return 0;
}
