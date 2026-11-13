import { useState } from 'react';
import { Download, Printer, CheckCircle2 } from 'lucide-react';
import { Toggle } from './ui';

/**
 * Plug-and-play printing.
 * Browsers can only print to the computer's printers, and normally show a print dialog each time. The launcher
 * downloaded here opens the POS / Kitchen Display in Chrome (or Edge) with "--kiosk-printing", so every receipt or
 * kitchen ticket goes straight to the Windows default printer with no dialog. It also adds itself to Windows startup.
 */

export const HW_KEY = 'its.hardware';
export const hwSettings = () => JSON.parse(localStorage.getItem(HW_KEY) || '{}');
export const saveHw = (patch: Record<string, any>) => localStorage.setItem(HW_KEY, JSON.stringify({ ...hwSettings(), ...patch }));

export type Station = 'pos' | 'kds';
const NAMES: Record<Station, { file: string; title: string; path: string }> = {
  pos: { file: 'RioLindo-Recepcion.cmd', title: 'Rio Lindo POS - Recepcion', path: '/pos' },
  kds: { file: 'RioLindo-Cocina.cmd', title: 'Rio Lindo POS - Cocina', path: '/kds' },
};

/** Windows launcher: finds Chrome/Edge, adds itself to Startup and the Desktop, opens the app with silent printing. */
export function launcherScript(kind: Station, origin = location.origin) {
  const n = NAMES[kind];
  const lines = [
    '@echo off',
    `title ${n.title}`,
    `set "URL=${origin}${n.path}?autoprint=1"`,
    `set "PROFILE=%LOCALAPPDATA%\\RioLindoPOS\\${kind}"`,
    'set "BROWSER="',
    'for %%B in ("%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe") do if not defined BROWSER if exist %%B set "BROWSER=%%~B"',
    'if not defined BROWSER (',
    '  echo Google Chrome or Microsoft Edge was not found. Install Google Chrome and run this file again.',
    '  pause',
    '  exit /b 1',
    ')',
    'set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"',
    'if /i not "%~dp0"=="%STARTUP%\\" if not exist "%STARTUP%\\%~nx0" copy /y "%~f0" "%STARTUP%\\" >nul',
    'if /i not "%~dp0"=="%USERPROFILE%\\Desktop\\" if not exist "%USERPROFILE%\\Desktop\\%~nx0" copy /y "%~f0" "%USERPROFILE%\\Desktop\\" >nul',
    'start "" "%BROWSER%" --user-data-dir="%PROFILE%" --kiosk-printing --no-first-run --disable-print-preview --app="%URL%"',
    '',
  ];
  return lines.join('\r\n');
}

export function downloadLauncher(kind: Station) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([launcherScript(kind)], { type: 'application/octet-stream' }));
  a.download = NAMES[kind].file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Applies "?autoprint=1" from the launcher: turns automatic printing on for this device. */
export function applyAutoprintParam(kind: Station) {
  const q = new URLSearchParams(location.search);
  if (q.get('autoprint') !== '1') return;
  if (kind === 'pos') saveHw({ autoPrint: true });
  else enableKdsAutoprint(true);
  q.delete('autoprint');
  history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : ''));
}

/** Turns kitchen auto-print on/off; only orders created after it was turned on are printed. */
export function enableKdsAutoprint(on: boolean) {
  if (on && localStorage.getItem('its.kds.autoprint') !== '1') localStorage.setItem('its.kds.autoprint_since', String(Date.now()));
  localStorage.setItem('its.kds.autoprint', on ? '1' : '0');
}

export function PrinterSetup({ kind, onTestPrint }: { kind: Station; onTestPrint: () => void }) {
  const [hw, setHw] = useState<any>(hwSettings);
  const [kdsAuto, setKdsAuto] = useState(localStorage.getItem('its.kds.autoprint') === '1');
  const set = (k: string, v: any) => { saveHw({ [k]: v }); setHw(hwSettings()); };
  const windows = /Windows/i.test(navigator.userAgent);
  const steps = [
    <>Conecte la impresora (USB o red) y enciéndala. Windows la detecta e instala el controlador automáticamente. Si no aparece, instale el controlador del fabricante (Epson, Star, Xprinter…).</>,
    <>En Windows → <b>Configuración → Impresoras</b>, márquela como <b>predeterminada</b> y desactive "Permitir que Windows administre la impresora predeterminada". Papel: 80 mm (o 58 mm).</>,
    <>Descargue el <b>iniciador</b> de abajo y ábralo (doble clic). Abre {kind === 'pos' ? 'la caja' : 'la pantalla de cocina'} en modo de <b>impresión automática sin diálogo</b>, y queda en el escritorio y en el inicio de Windows.</>,
    <>La primera vez, registre {kind === 'pos' ? 'esta caja' : 'esta pantalla de cocina'} en la ventana que se abre. Luego pulse <b>Imprimir prueba</b>.</>,
  ];

  return (
    <div className="space-y-4">
      <ol className="space-y-2 text-sm">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">{i + 1}</span>
            <span className="text-slate-700 dark:text-slate-300">{s}</span>
          </li>
        ))}
      </ol>
      <div className="grid gap-2 sm:grid-cols-2">
        <button className="btn-primary" onClick={() => downloadLauncher(kind)}><Download size={16} />Descargar iniciador ({kind === 'pos' ? 'Recepción' : 'Cocina'})</button>
        <button className="btn-secondary" onClick={onTestPrint}><Printer size={16} />Imprimir prueba</button>
      </div>
      {!windows && <p className="text-xs text-amber-600">El iniciador es para Windows. En tabletas o Mac, imprima desde el diálogo del navegador; la impresión automática sin diálogo requiere Windows con Chrome o Edge.</p>}
      <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        {kind === 'pos' ? (
          <>
            <Toggle checked={hw.autoPrint ?? true} onChange={(v) => set('autoPrint', v)} label="Imprimir el recibo al cobrar" />
            <Toggle checked={hw.kitchenPrint ?? false} onChange={(v) => set('kitchenPrint', v)} label="Imprimir también la comanda de cocina en esta impresora" />
            <p className="text-xs text-slate-500">Use la segunda opción solo si no hay impresora en la cocina. Con impresora en cocina, active la impresión automática en la pantalla de cocina.</p>
          </>
        ) : (
          <Toggle checked={kdsAuto} onChange={(v) => { enableKdsAutoprint(v); setKdsAuto(v); }} label="Imprimir automáticamente cada pedido nuevo" />
        )}
        <Toggle checked={(hw.paper || '80mm') === '58mm'} onChange={(v) => set('paper', v ? '58mm' : '80mm')} label="Papel de 58 mm" />
      </div>
      <p className="flex items-start gap-2 text-xs text-slate-500"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />Si la ventana muestra el diálogo de impresión, ciérrela y ábrala con el iniciador: el modo sin diálogo solo funciona desde él.</p>
    </div>
  );
}
