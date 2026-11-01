// Bounded lock-free multi-producer queue of fixed-size audio frames (Dmitry Vyukov's bounded MPMC
// queue). TeamSpeak's playback callbacks push; the sender thread pops. A push never waits for the
// consumer: when the queue is full the frame is refused (and counted by the caller). Producers only
// contend with each other on one atomic index.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>

namespace mf {

// One callback's samples (a longer callback is split over several frames).
constexpr std::size_t kMaxFrameSamples = 4096;  // interleaved int16 samples (2048 stereo frames)

struct AudioFrame {
  uint64_t schid;     // TeamSpeak server connection handler (the tab)
  uint64_t tUs;       // plugin monotonic clock, microseconds, when the callback ran
  uint32_t frames;    // samples per channel
  uint16_t clientId;  // TeamSpeak session client id (re-resolved to the unique identity by the sender)
  uint8_t channels;   // 1 or 2
  uint8_t part;       // 0 for the first frame of a callback, then 1, 2... when it was split
  int16_t pcm[kMaxFrameSamples];
};

class FrameQueue {
 public:
  explicit FrameQueue(std::size_t capacityPow2) : mask_(capacityPow2 - 1), cells_(new Cell[capacityPow2]) {
    for (std::size_t i = 0; i < capacityPow2; i++) cells_[i].seq.store(i, std::memory_order_relaxed);
    enq_.store(0, std::memory_order_relaxed);
    deq_.store(0, std::memory_order_relaxed);
  }

  std::size_t capacity() const { return mask_ + 1; }

  // Claims a cell, lets `fill` write the frame, publishes it. False when full (nothing written).
  template <typename Fill>
  bool tryPush(Fill&& fill) {
    Cell* cell;
    std::size_t pos = enq_.load(std::memory_order_relaxed);
    for (;;) {
      cell = &cells_[pos & mask_];
      const std::size_t seq = cell->seq.load(std::memory_order_acquire);
      const intptr_t dif = static_cast<intptr_t>(seq) - static_cast<intptr_t>(pos);
      if (dif == 0) {
        if (enq_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) break;
      } else if (dif < 0) {
        return false;  // full
      } else {
        pos = enq_.load(std::memory_order_relaxed);
      }
    }
    fill(cell->frame);
    cell->seq.store(pos + 1, std::memory_order_release);
    return true;
  }

  // Hands the oldest frame to `use` (in place, no copy), then frees its cell. False when empty.
  template <typename Use>
  bool tryPop(Use&& use) {
    Cell* cell;
    std::size_t pos = deq_.load(std::memory_order_relaxed);
    for (;;) {
      cell = &cells_[pos & mask_];
      const std::size_t seq = cell->seq.load(std::memory_order_acquire);
      const intptr_t dif = static_cast<intptr_t>(seq) - static_cast<intptr_t>(pos + 1);
      if (dif == 0) {
        if (deq_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) break;
      } else if (dif < 0) {
        return false;  // empty
      } else {
        pos = deq_.load(std::memory_order_relaxed);
      }
    }
    use(cell->frame);
    cell->seq.store(pos + mask_ + 1, std::memory_order_release);
    return true;
  }

  // Approximate number of queued frames (for the statistics only).
  std::size_t depth() const {
    const std::size_t e = enq_.load(std::memory_order_relaxed);
    const std::size_t d = deq_.load(std::memory_order_relaxed);
    return e >= d ? e - d : 0;
  }

 private:
  struct Cell {
    std::atomic<std::size_t> seq;
    AudioFrame frame;
  };
  const std::size_t mask_;
  std::unique_ptr<Cell[]> cells_;
  alignas(64) std::atomic<std::size_t> enq_;
  alignas(64) std::atomic<std::size_t> deq_;
};

}  // namespace mf
