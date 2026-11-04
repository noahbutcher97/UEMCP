import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RC_SECTION = '/Script/RemoteControlCommon.RemoteControlSettings';
export const TRANSPORT_FILES = ['Config/DefaultUEMCP.ini', 'Config/DefaultRemoteControl.ini'];

export function iniPort(text, wantedSection, wantedKey) {
  let section = '', value = null;
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) { section = heading[1].toLowerCase(); continue; }
    const entry = line.match(/^([^=]+)=(.*)$/);
    if (section !== wantedSection.toLowerCase() || entry?.[1].trim().toLowerCase() !== wantedKey.toLowerCase()) continue;
    if (value !== null) throw new Error(`Duplicate transport port setting: ${wantedKey}`);
    const number = entry[2].trim();
    if (!/^\d+$/.test(number) || Number(number) < 1 || Number(number) > 65535) throw new Error(`Invalid transport port configuration: ${wantedKey}`);
    value = Number(number);
  }
  return value;
}

export function readProjectTransport(projectRoot, fallback = { tcpPortCustom: 55558, rcPort: 30010 }) {
  const read = relative => {
    const path = join(projectRoot, relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  const tcp = iniPort(read(TRANSPORT_FILES[0]), 'UEMCP', 'TcpPort');
  const defaultHttp = iniPort(read(TRANSPORT_FILES[1]), RC_SECTION, 'RemoteControlHttpServerPort');
  const savedHttp = iniPort(read('Saved/Config/WindowsEditor/RemoteControl.ini'), RC_SECTION, 'RemoteControlHttpServerPort');
  const http = savedHttp ?? defaultHttp;
  const ports = { tcpPortCustom: tcp ?? fallback.tcpPortCustom, rcPort: http ?? fallback.rcPort };
  if (ports.tcpPortCustom === ports.rcPort) throw new Error('TCP and HTTP transport ports must be distinct');
  return { ports, source: tcp !== null || http !== null ? 'project' : 'session', configured: { tcp, http } };
}
