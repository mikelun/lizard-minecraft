// Starts the compiled game server (npm run build:server first) and plays a
// short match with two real Colyseus clients.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "colyseus.js";

const ENTRY = "server/dist/index.js";
const PORT = 19000 + Math.floor(Math.random() * 1000);

let server: ChildProcess;

function next<T = any>(room: Room, type: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no '${type}' within ${timeoutMs}ms`)), timeoutMs);
    const off = room.onMessage(type, (msg: T) => {
      clearTimeout(t);
      off();
      resolve(msg);
    });
  });
}

describe.skipIf(!existsSync(ENTRY))("game server", () => {
  beforeAll(async () => {
    server = spawn(process.execPath, [ENTRY], { env: { ...process.env, PORT: String(PORT) } });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 15000);
      server.stdout!.on("data", (d) => {
        if (String(d).includes("listening")) {
          clearTimeout(t);
          resolve();
        }
      });
      server.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
    });
  }, 20000);

  afterAll(() => {
    server?.kill();
  });

  it("welcomes players, relays joins, applies damage", async () => {
    const client = new Client(`ws://127.0.0.1:${PORT}`);

    const a = await client.joinOrCreate("game");
    const welcomeA = await next(a, "welcome");
    expect(welcomeA.id).toBe(a.sessionId);
    expect(welcomeA.players).toEqual([]);

    const joined = next(a, "join");
    const b = await client.join("game");
    const welcomeB = await next(b, "welcome");
    expect(welcomeB.players.map((p: any) => p.id)).toEqual([a.sessionId]);
    expect((await joined).id).toBe(b.sessionId);

    // With two clients the server starts broadcasting position ticks.
    const tick = await next(b, "tick");
    expect(tick.players).toHaveLength(2);

    const hp = next(a, "hp");
    a.send("hit", { targetId: b.sessionId, zone: 0 });
    const msg = await hp;
    expect(msg.id).toBe(b.sessionId);
    expect(msg.hp).toBeLessThan(300);
    expect(msg.hp).toBeGreaterThan(0);

    const left = next(a, "leave");
    await b.leave();
    expect((await left).id).toBe(b.sessionId);
    await a.leave();
  }, 20000);
});
