import { io, type Socket } from 'socket.io-client';

export function connectSocket(token: string, storeId?: string | null): Socket {
  return io({ auth: { token, storeId }, transports: ['websocket', 'polling'] });
}

export function initTheme() {
  const t = localStorage.getItem('its.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.classList.toggle('dark', t === 'dark');
}
export function toggleTheme() {
  const dark = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('its.theme', dark ? 'dark' : 'light');
}

/** Short beep for KDS new orders / scanner feedback (no audio files needed). */
export function beep(freq = 880, ms = 160) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    o.start();
    o.stop(ctx.currentTime + ms / 1000);
  } catch {
    /* audio not allowed yet */
  }
}

/** Resize an image file to a small data URL for product photos / logos. */
export function imageToDataUrl(file: File, max = 320): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
