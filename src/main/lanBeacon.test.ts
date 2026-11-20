import { EventEmitter } from 'node:events';
import type dgram from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MC_LAN_GROUP, MC_LAN_PORT, parseLanAnnouncement, startLanBeacon } from './lanBeacon';

describe('parseLanAnnouncement', () => {
  it('reads the vanilla [MOTD]..[/MOTD][AD]port[/AD] format', () => {
    expect(parseLanAnnouncement('[MOTD]Yuki - New World[/MOTD][AD]63711[/AD]')).toEqual({
      port: 63711,
      motd: 'Yuki - New World',
    });
  });

  it('accepts a host:port [AD] and a missing MOTD', () => {
    expect(parseLanAnnouncement('[AD]192.168.1.20:56048[/AD]')).toEqual({ port: 56048, motd: '' });
  });

  it('keeps non-ASCII and section-sign MOTDs', () => {
    expect(parseLanAnnouncement('[MOTD]§aトリ - 新しい世界[/MOTD][AD]50000[/AD]')?.motd).toBe('§aトリ - 新しい世界');
  });

  it('rejects junk and out-of-range ports', () => {
    expect(parseLanAnnouncement('hello')).toBeNull();
    expect(parseLanAnnouncement('[MOTD]x[/MOTD][AD]0[/AD]')).toBeNull();
    expect(parseLanAnnouncement('[MOTD]x[/MOTD][AD]70000[/AD]')).toBeNull();
    expect(parseLanAnnouncement('[MOTD]x[/MOTD][AD]abc[/AD]')).toBeNull();
  });
});

class FakeSocket extends EventEmitter {
  bound: number | null = null;
  groups: string[] = [];
  closed = false;
  bind(port: number, cb: () => void): void {
    this.bound = port;
    cb();
  }
  addMembership(group: string): void {
    this.groups.push(group);
  }
  close(): void {
    this.closed = true;
  }
}

describe('startLanBeacon', () => {
  afterEach(() => vi.useRealTimers());

  it('binds 4445, joins the group, and lists fresh announcements newest first', () => {
    let t = 1000;
    const sock = new FakeSocket();
    const b = startLanBeacon({ createSocket: () => sock as unknown as dgram.Socket, now: () => t });
    expect(sock.bound).toBe(MC_LAN_PORT);
    expect(sock.groups).toEqual([MC_LAN_GROUP]);
    expect(b.listening).toBe(true);
    sock.emit('message', Buffer.from('[MOTD]A[/MOTD][AD]50001[/AD]'));
    t = 2000;
    sock.emit('message', Buffer.from('[MOTD]B[/MOTD][AD]50002[/AD]'));
    sock.emit('message', Buffer.from('not an announcement'));
    expect(b.entries(5000).map((e) => e.port)).toEqual([50002, 50001]);
    t = 6500; // 50001 is now 5.5s old
    expect(b.entries(5000).map((e) => e.port)).toEqual([50002]);
    b.stop();
    expect(sock.closed).toBe(true);
    expect(b.entries(5000)).toEqual([]);
  });

  it('a membership failure leaves it inert instead of throwing', () => {
    const sock = new FakeSocket();
    sock.addMembership = () => {
      throw new Error('EADDRNOTAVAIL');
    };
    const b = startLanBeacon({ createSocket: () => sock as unknown as dgram.Socket });
    expect(b.listening).toBe(false);
    expect(sock.closed).toBe(true);
    b.stop();
  });

  it('recreates an idle socket (a dropped subscription recovers)', () => {
    vi.useFakeTimers();
    let t = 0;
    const socks: FakeSocket[] = [];
    const b = startLanBeacon({
      createSocket: () => {
        const s = new FakeSocket();
        socks.push(s);
        return s as unknown as dgram.Socket;
      },
      now: () => t,
    });
    t = 31_000;
    vi.advanceTimersByTime(30_000);
    expect(socks.length).toBeGreaterThanOrEqual(2);
    expect(socks[0].closed).toBe(true);
    b.stop();
  });
});
