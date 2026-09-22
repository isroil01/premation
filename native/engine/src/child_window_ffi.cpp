#include "child_window_ffi.hpp"

#include <windows.h>

#include <cstdio>

namespace premation::win {
namespace {

constexpr const wchar_t* kClassName = L"PremationEngineViewport";

LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;  // the swapchain covers every pixel; no GDI flash
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATE;  // never take focus from the page
    default:
      return DefWindowProcW(hwnd, msg, wp, lp);
  }
}

}  // namespace

ChildWindow::~ChildWindow() {
  if (hwnd_ != nullptr) DestroyWindow(static_cast<HWND>(hwnd_));
}

bool ChildWindow::create(std::uint64_t parentHwnd, Rect rect, bool inputTransparent) {
  HINSTANCE inst = GetModuleHandleW(nullptr);
  hinstance_ = inst;
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = wnd_proc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);

  // NOLINTNEXTLINE(performance-no-int-to-ptr): an HWND arrives as an integer from Electron.
  const auto parent = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(parentHwnd));
  DWORD style = WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;
  if (inputTransparent) style |= WS_DISABLED;
  rect_ = rect;
  // Cross-process parenting: Windows attaches the two threads' input queues.
  // That is the documented cost of this route (see docs/VIEWPORT_ROUTE.md).
  HWND hwnd = CreateWindowExW(WS_EX_NOPARENTNOTIFY, kClassName, L"premation-engine viewport", style, rect.x, rect.y,
                              rect.w > 0 ? rect.w : 1, rect.h > 0 ? rect.h : 1, parent, nullptr, inst, nullptr);
  if (hwnd == nullptr) {
    std::fprintf(stderr, "engine: CreateWindowEx(child of %llu) failed: %lu\n",
                 static_cast<unsigned long long>(parentHwnd), GetLastError());
    return false;
  }
  hwnd_ = hwnd;
  SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  return true;
}

void ChildWindow::set_rect(Rect rect) {
  rect_ = rect;
  SetWindowPos(static_cast<HWND>(hwnd_), HWND_TOP, rect.x, rect.y, rect.w > 0 ? rect.w : 1, rect.h > 0 ? rect.h : 1,
               SWP_NOACTIVATE | SWP_NOCOPYBITS);
}

void ChildWindow::set_holes(std::span<const Rect> holes) {
  auto* hwnd = static_cast<HWND>(hwnd_);
  if (holes.empty()) {
    SetWindowRgn(hwnd, nullptr, TRUE);
    return;
  }
  HRGN region = CreateRectRgn(0, 0, rect_.w, rect_.h);
  for (const Rect& h : holes) {
    // Holes arrive in parent-client pixels; the region is window-local.
    HRGN hole = CreateRectRgn(h.x - rect_.x, h.y - rect_.y, h.x - rect_.x + h.w, h.y - rect_.y + h.h);
    CombineRgn(region, region, hole, RGN_DIFF);
    DeleteObject(hole);
  }
  // On success the system owns `region`.
  if (SetWindowRgn(hwnd, region, TRUE) == 0) DeleteObject(region);
}

bool ChildWindow::pump() {
  MSG msg{};
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE) != 0) {
    if (msg.message == WM_QUIT) return false;
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return IsWindow(static_cast<HWND>(hwnd_)) != 0;
}

}  // namespace premation::win
