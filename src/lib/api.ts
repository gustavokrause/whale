import { NextResponse } from "next/server";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

export const fail = (e: unknown, status = 400) =>
  NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
