# Create the dev Start Menu shortcut WITH its AppUserModelID property set.
#
# Electron's writeShortcutLink cannot persist the AUMID property, and without
# it the taskbar resolves the running dev app to the runtime's own icon (the
# Electron atom) instead of the app's. Run this once (and again after the icon
# file changes):
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-shortcut.ps1

$ErrorActionPreference = 'Stop'

$desktop = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
# The branded runtime copy (scripts\dev-runtime-icon.ps1) carries the app icon;
# fall back to electron.exe before it exists.
$target  = "$env:LOCALAPPDATA\medhealthbuddy-dev\electron\MedHealthBuddy.exe"
if (-not (Test-Path $target)) { $target = "$env:LOCALAPPDATA\medhealthbuddy-dev\electron\electron.exe" }
$appPath = Join-Path $desktop '.'
$icon    = Join-Path $desktop 'assets\app.ico'
$link    = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\MedHealthBuddy (dev).lnk"
$aumid   = 'medhealthbuddy-desktop.dev'
$desc    = 'medhealthbuddy-desktop (development build)'

if (-not (Test-Path $target)) { throw "Electron runtime not found: $target (run setup-electron-runtime.cmd first)" }
if (-not (Test-Path $icon))   { throw "Icon not found: $icon" }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace DevShortcut {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey {
    public Guid fmtid;
    public int pid;
    public PropertyKey(Guid guid, int id) { fmtid = guid; pid = id; }
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class ShellLink { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int cch, IntPtr data, uint flags);
    void GetIDList(out IntPtr list);
    void SetIDList(IntPtr list);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out short key);
    void SetHotkey(short key);
    void GetShowCmd(out int show);
    void SetShowCmd(int show);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int cch, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string rel, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
  }

  public static class Writer {
    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    public static void Write(string target, string args, string icon, string description, string linkPath, string aumid) {
      IShellLinkW link = (IShellLinkW)new ShellLink();
      link.SetPath(target);
      link.SetArguments(args);
      link.SetIconLocation(icon, 0);
      link.SetDescription(description);

      // System.AppUserModel.ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5.
      PropertyKey key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
      PropVariant value = new PropVariant();
      value.vt = 31; // VT_LPWSTR
      value.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
      IPropertyStore store = (IPropertyStore)link;
      store.SetValue(ref key, ref value);
      PropVariantClear(ref value);
      store.Commit();

      // Save last: committing the property store binds it to the saved file.
      IPersistFile persist = (IPersistFile)link;
      persist.Save(linkPath, true);
    }
  }
}
'@

[DevShortcut.Writer]::Write($target, "`"$appPath`"", $icon, $desc, $link, $aumid)
Write-Output "shortcut written: $link (AUMID $aumid, icon $icon)"
