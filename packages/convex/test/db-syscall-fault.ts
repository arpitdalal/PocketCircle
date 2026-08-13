import { z } from "zod";

const insertSyscallArgs = z.object({ table: z.string() });

function convexRuntime() {
  const convex = Reflect.get(globalThis, "Convex");
  if (typeof convex !== "object" || convex === null) {
    throw new Error("Convex runtime missing");
  }
  return convex;
}

/**
 * Fail the next `count` inserts into `table` at the convex-test DB syscall.
 * IO boundary only — production writers (e.g. `recordEvent`) still run.
 */
export function failNextTableInserts(table: string, count: number) {
  const remaining = { count };
  const convex = convexRuntime();
  const descriptor = Object.getOwnPropertyDescriptor(convex, "asyncSyscall");
  if (descriptor?.get === undefined) {
    throw new Error("Convex asyncSyscall getter missing");
  }
  const originalGet = descriptor.get;
  Object.defineProperty(convex, "asyncSyscall", {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get() {
      const impl: unknown = originalGet.call(convex);
      if (typeof impl !== "function") {
        throw new Error("Convex asyncSyscall missing");
      }
      return async (op: string, jsonArgs: string) => {
        if (op === "1.0/insert" && remaining.count > 0) {
          const parsed = insertSyscallArgs.safeParse(JSON.parse(jsonArgs));
          if (parsed.success && parsed.data.table === table) {
            remaining.count -= 1;
            throw new Error(`${table} insert failed`);
          }
        }
        return impl(op, jsonArgs);
      };
    },
  });
  return () => {
    Object.defineProperty(convex, "asyncSyscall", descriptor);
  };
}
