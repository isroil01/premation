// Route B: a WS_CHILD window the engine owns, parented to the Electron
// BrowserWindow's HWND (another process), placed over the page's viewport rect.
#pragma once

#include <cstdint>
#include <span>

namespace premation::win {

struct Rect {
  int x = 0;
  int y = 0;
  int w = 0;
  int h = 0;
};

class ChildWindow {
 public:
  ChildWindow() = default;
  ~ChildWindow();
  ChildWindow(const ChildWindow&) = delete;
  ChildWindow& operator=(const ChildWindow&) = delete;
  ChildWindow(ChildWindow&&) = delete;
  ChildWindow& operator=(ChildWindow&&) = delete;

  // `inputTransparent`: WS_DISABLED, so mouse input over the viewport is
  // routed to the parent (the page) instead of the engine's window.
  bool create(std::uint64_t parentHwnd, Rect rect, bool inputTransparent);
  void set_rect(Rect rect);
  // Cut these parent-client rects out of the window (SetWindowRgn), so HTML
  // drawn by the page there (a dropdown) is not covered. Empty = no region.
  void set_holes(std::span<const Rect> holes);

  // Dispatch pending window messages; false once the window is gone.
  bool pump();

  void* hwnd() const { return hwnd_; }
  void* hinstance() const { return hinstance_; }
  Rect rect() const { return rect_; }

 private:
  void* hwnd_ = nullptr;
  void* hinstance_ = nullptr;
  Rect rect_{};
};

}  // namespace premation::win
