#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>

extern "C" __declspec(dllimport) BOOL __cdecl InstallerPresentWelcome(HWND window);

static bool Above(HWND upper, HWND lower) {
    for (HWND current = GetWindow(lower, GW_HWNDPREV); current;
         current = GetWindow(current, GW_HWNDPREV)) {
        if (current == upper) return true;
    }
    return false;
}

int wmain() {
    HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW windowClass = {};
    windowClass.lpfnWndProc = DefWindowProcW;
    windowClass.hInstance = instance;
    windowClass.lpszClassName = L"HarnessInstallerPresentationTest";
    if (!RegisterClassW(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return 1;
    HWND installer = CreateWindowExW(0, windowClass.lpszClassName, L"Installer", WS_POPUP,
                                     100, 100, 300, 300, nullptr, nullptr, instance, nullptr);
    HWND other = CreateWindowExW(0, windowClass.lpszClassName, L"Other", WS_POPUP,
                                 120, 120, 300, 300, nullptr, nullptr, instance, nullptr);
    if (!installer || !other) return 1;
    // Establish the precondition explicitly.  The smoke test is launched with
    // the child console hidden, so relying on ShowWindow's implicit z-order
    // would make the result depend on the runner's foreground window.
    ShowWindow(installer, SW_SHOWNOACTIVATE);
    ShowWindow(other, SW_SHOWNOACTIVATE);
    SetWindowPos(installer, HWND_BOTTOM, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    SetWindowPos(other, HWND_TOP, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    if (!Above(other, installer)) return 2;
    if (!InstallerPresentWelcome(installer)) return 3;
    if (!Above(installer, other)) return 4;
    if (GetWindowLongPtrW(installer, GWL_EXSTYLE) & WS_EX_TOPMOST) return 5;
    if (GetPropW(installer, L"HarnessInstaller.Presented") != reinterpret_cast<HANDLE>(1)) return 6;
    DestroyWindow(other);
    DestroyWindow(installer);
    return 0;
}
