import { DubApiError, handleAndReturnErrorResponse } from "@/lib/api/errors";
import { hashToken } from "@/lib/auth/hash";
import prisma from "@/lib/prisma";
import { getSearchParams } from "@dub/utils";
import { ratelimit } from "../upstash";
import { Session, getSession } from "./utils";

export interface WithSessionHandler {
  ({
    req,
    params,
    searchParams,
    session,
  }: {
    req: Request;
    params: Record<string, string>;
    searchParams: Record<string, string>;
    session: Session;
  }): Promise<Response>;
}

export const withSession =
  (handler: WithSessionHandler) =>
  async (req: Request, { params }: { params: Record<string, string> }) => {
    try {
      let session: Session | undefined;
      let headers = {};

      const authorizationHeader = req.headers.get("Authorization");
      if (authorizationHeader) {
        if (!authorizationHeader.includes("Bearer ")) {
          throw new DubApiError({
            code: "bad_request",
            message:
              "Misconfigured authorization header. Did you forget to add 'Bearer '? Learn more: https://d.to/auth",
          });
        }
        const apiKey = authorizationHeader.replace("Bearer ", "");

        const hashedKey = hashToken(apiKey, {
          noSecret: true,
        });

        const user = await prisma.user.findFirst({
          where: {
            tokens: {
              some: {
                hashedKey,
              },
            },
          },
          select: {
            id: true,
            name: true,
            email: true,
          },
        });
        if (!user) {
          throw new DubApiError({
            code: "unauthorized",
            message: "Unauthorized: Invalid API key.",
          });
        }

        const { success, limit, reset, remaining } = await ratelimit(
          600,
          "1 m",
        ).limit(apiKey);

        headers = {
          "Retry-After": reset.toString(),
          "X-RateLimit-Limit": limit.toString(),
          "X-RateLimit-Remaining": remaining.toString(),
          "X-RateLimit-Reset": reset.toString(),
        };

        if (!success) {
          return new Response("Too many requests.", {
            status: 429,
            headers,
          });
        }
        await prisma.token.update({
          where: {
            hashedKey,
          },
          data: {
            lastUsed: new Date(),
          },
        });
        session = {
          user: {
            id: user.id,
            name: user.name || "",
            email: user.email || "",
          },
        };
      } else {
        session = await getSession();
        if (!session?.user.id) {
          throw new DubApiError({
            code: "unauthorized",
            message: "Unauthorized: Login required.",
          });
        }
      }

      const searchParams = getSearchParams(req.url);
      return await handler({ req, params, searchParams, session });
    } catch (error) {
      return handleAndReturnErrorResponse(error);
    }
  };
