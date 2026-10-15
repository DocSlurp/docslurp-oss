import type { Hono } from "hono";

type TestSessionUser = {
  id: string;
  email?: string;
  name?: string;
  image?: string | null;
};

export function withTestSession(
  app: Hono,
  sessionUser: TestSessionUser = {
    id: "demo-user",
    email: "demo@example.com",
    name: "Demo User",
    image: null
  }
): Hono {
  app.use("*", async (c, next) => {
    c.set(
      "sessionUser",
      {
        email: "demo@example.com",
        name: "Demo User",
        image: null,
        ...sessionUser
      } as never
    );
    await next();
  });

  return app;
}
