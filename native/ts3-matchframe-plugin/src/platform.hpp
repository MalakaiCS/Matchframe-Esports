// What differs between Windows and Linux: the monotonic clock, TCP sockets on 127.0.0.1 and where
// Matchframe's data folder is.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#endif

namespace mf {

// Microseconds on a clock that never jumps (QueryPerformanceCounter / CLOCK_MONOTONIC).
inline uint64_t monoUs() {
#if defined(_WIN32)
  static LARGE_INTEGER freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f;
  }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return static_cast<uint64_t>((static_cast<long double>(c.QuadPart) * 1000000.0L) / static_cast<long double>(freq.QuadPart));
#else
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000000ull + static_cast<uint64_t>(ts.tv_nsec) / 1000ull;
#endif
}

// Environment variables as UTF-8 (Windows: the wide-character API, so a user name with accents works).
inline std::string envStr(const char* name) {
#if defined(_WIN32)
  wchar_t wname[128];
  if (MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 128) == 0) return std::string();
  wchar_t buf[2048];
  DWORD n = GetEnvironmentVariableW(wname, buf, 2048);
  if (n == 0 || n >= 2048) return std::string();
  int len = WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(n), nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(len), '\0');
  WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(n), &s[0], len, nullptr, nullptr);
  return s;
#else
  const char* v = std::getenv(name);
  return v ? std::string(v) : std::string();
#endif
}

// Reads a small file named by a UTF-8 path. Empty when missing or larger than maxBytes.
inline std::string readSmallFile(const std::string& path, size_t maxBytes) {
  if (path.empty()) return std::string();
#if defined(_WIN32)
  int wl = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  if (wl <= 0) return std::string();
  std::wstring wp(static_cast<size_t>(wl), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &wp[0], wl);
  FILE* f = _wfopen(wp.c_str(), L"rb");
#else
  FILE* f = std::fopen(path.c_str(), "rb");
#endif
  if (!f) return std::string();
  std::string s(maxBytes + 1, '\0');
  size_t n = std::fread(&s[0], 1, maxBytes + 1, f);
  std::fclose(f);
  if (n > maxBytes) return std::string();
  s.resize(n);
  return s;
}

#if defined(_WIN32)
constexpr char kPathSep = '\\';
#else
constexpr char kPathSep = '/';
#endif

// Writes a small file named by a UTF-8 path (whole, replacing it). False on failure.
inline bool writeSmallFile(const std::string& path, const std::string& content) {
  if (path.empty()) return false;
#if defined(_WIN32)
  int wl = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  if (wl <= 0) return false;
  std::wstring wp(static_cast<size_t>(wl), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &wp[0], wl);
  FILE* f = _wfopen(wp.c_str(), L"wb");
#else
  FILE* f = std::fopen(path.c_str(), "wb");
#endif
  if (!f) return false;
  const bool ok = std::fwrite(content.data(), 1, content.size(), f) == content.size();
  return std::fclose(f) == 0 && ok;
}

// The bridge file the engine writes (port and token): MATCHFRAME_COMMS_BRIDGE_FILE, else
// <data folder>/team-comms/bridge.json with the engine's data folder (MATCHFRAME_DATA_DIR, else
// %APPDATA%\Matchframe Esports, ~/Library/Application Support/Matchframe Esports or
// $XDG_DATA_HOME|~/.local/share/matchframe-esports).
inline std::string bridgeFilePath() {
  std::string f = envStr("MATCHFRAME_COMMS_BRIDGE_FILE");
  if (!f.empty()) return f;
#if defined(_WIN32)
  const char sep = '\\';
#else
  const char sep = '/';
#endif
  std::string dir = envStr("MATCHFRAME_DATA_DIR");
  if (dir.empty()) {
#if defined(_WIN32)
    std::string appData = envStr("APPDATA");
    if (appData.empty()) return std::string();
    dir = appData + "\\Matchframe Esports";
#elif defined(__APPLE__)
    dir = envStr("HOME") + "/Library/Application Support/Matchframe Esports";
#else
    std::string xdg = envStr("XDG_DATA_HOME");
    dir = (xdg.empty() ? envStr("HOME") + "/.local/share" : xdg) + "/matchframe-esports";
#endif
  }
  return dir + sep + "team-comms" + sep + "bridge.json";
}

#if defined(_WIN32)
using Socket = SOCKET;
constexpr Socket kNoSocket = INVALID_SOCKET;
inline void closeSocket(Socket s) { closesocket(s); }
inline bool netInit() {
  WSADATA w;
  return WSAStartup(MAKEWORD(2, 2), &w) == 0;
}
inline void netDone() { WSACleanup(); }
#else
using Socket = int;
constexpr Socket kNoSocket = -1;
inline void closeSocket(Socket s) { close(s); }
inline bool netInit() { return true; }
inline void netDone() {}
#endif

// Connects to 127.0.0.1:port (never another host), with send/receive timeouts. kNoSocket on failure.
inline Socket connectLoopback(uint16_t port, int timeoutMs) {
  Socket s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == kNoSocket) return kNoSocket;
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
#if defined(_WIN32)
  u_long nb = 1;
  ioctlsocket(s, FIONBIO, &nb);
  int r = connect(s, reinterpret_cast<sockaddr*>(&a), sizeof a);
  if (r != 0 && WSAGetLastError() != WSAEWOULDBLOCK) {
    closeSocket(s);
    return kNoSocket;
  }
  fd_set w;
  FD_ZERO(&w);
  FD_SET(s, &w);
  timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
  if (select(0, nullptr, &w, nullptr, &tv) != 1) {
    closeSocket(s);
    return kNoSocket;
  }
  int err = 0;
  int len = sizeof err;
  getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&err), &len);
  if (err != 0) {
    closeSocket(s);
    return kNoSocket;
  }
  nb = 0;
  ioctlsocket(s, FIONBIO, &nb);
  DWORD to = 1000;
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&to), sizeof to);
#else
  int fl = fcntl(s, F_GETFL, 0);
  fcntl(s, F_SETFL, fl | O_NONBLOCK);
  int r = connect(s, reinterpret_cast<sockaddr*>(&a), sizeof a);
  if (r != 0 && errno != EINPROGRESS) {
    closeSocket(s);
    return kNoSocket;
  }
  pollfd p{s, POLLOUT, 0};
  if (poll(&p, 1, timeoutMs) != 1) {
    closeSocket(s);
    return kNoSocket;
  }
  int err = 0;
  socklen_t len = sizeof err;
  getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &len);
  if (err != 0) {
    closeSocket(s);
    return kNoSocket;
  }
  fcntl(s, F_SETFL, fl & ~O_NONBLOCK);
  timeval to{1, 0};
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &to, sizeof to);
#endif
  int one = 1;
  setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof one);
  return s;
}

// Sends everything or fails (a send blocked for more than a second fails).
inline bool sendAll(Socket s, const uint8_t* data, size_t len) {
  while (len > 0) {
#if defined(_WIN32)
    int n = send(s, reinterpret_cast<const char*>(data), static_cast<int>(len), 0);
#else
    ssize_t n = send(s, data, len, MSG_NOSIGNAL);
#endif
    if (n <= 0) return false;
    data += n;
    len -= static_cast<size_t>(n);
  }
  return true;
}

// Waits up to timeoutMs for data. 1: readable, 0: timeout, -1: error.
inline int waitReadable(Socket s, int timeoutMs) {
#if defined(_WIN32)
  fd_set r;
  FD_ZERO(&r);
  FD_SET(s, &r);
  timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
  int n = select(0, &r, nullptr, nullptr, &tv);
  return n < 0 ? -1 : (n == 0 ? 0 : 1);
#else
  pollfd p{s, POLLIN, 0};
  int n = poll(&p, 1, timeoutMs);
  if (n < 0) return errno == EINTR ? 0 : -1;
  if (n == 0) return 0;
  return (p.revents & (POLLERR | POLLNVAL)) ? -1 : 1;
#endif
}

// Reads what is there (after waitReadable): bytes read, 0 when the peer closed, -1 on error.
inline long recvSome(Socket s, uint8_t* buf, size_t cap) {
#if defined(_WIN32)
  int n = recv(s, reinterpret_cast<char*>(buf), static_cast<int>(cap), 0);
#else
  ssize_t n = recv(s, buf, cap, 0);
#endif
  return static_cast<long>(n);
}

}  // namespace mf
