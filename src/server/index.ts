import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { reddit, redis, createServer, getServerPort } from "@devvit/web/server";
import type { T1 } from "@devvit/shared-types/tid.js";
import type {
    OnCommentCreateRequest,
    TriggerResponse
} from "@devvit/web/shared";

const BOT_DISCLAIMER =
    "\n\n---\n^KrukBot29 ^is ^not ^affiliated ^with ^John ^Kruk ^or ^the ^Phillies";

// Only fire in recognized Phillies game/recap threads
const GAME_THREAD_REGEX =
    /\b(game\s+day\s+thread|game\s+thread|off\s+day\s+thread|the\s+phillies\s+(fell\s+to|defeated))\b/i;

// Ordered list: first matching pattern wins. Patterns are tested against the full comment body (case-insensitive).
// Add entries here to map found text → specific Kruk reply.
const KEYWORD_REPLIES: { pattern: RegExp; reply: string | ((id: string) => string) }[] = [
    {
        pattern: /\bhome\s*run\b/i,
        reply: "OH MY GOD! Gone! See ya! Bye bye baseball!",
    },
    {
        pattern: /\bstrike\s*out\b/i,
        reply: "He went up there hacking, Tom.",
    },
    {
        pattern: /\b(error|muff|bobble)\b/i,
        reply: "That ball had eyes, Tom.",
    },
    {
        pattern: /\b(walk|base on balls)\b/i,
        reply: "You don't walk off the island, Tom.",
    },
    {
        pattern: /\b(double play|twin killing)\b/i,
        reply: "Two for the price of one, Tom.",
    },
    {
        pattern: /\b(bryce|harper)\b/i,
        reply: "He's the best player in baseball, Tom. I said it.",
    },
    {
        pattern: /\b(schwarber|kyle)\b/i,
        reply: "He can hit a ball farther than any human being I've ever seen, Tom.",
    },
    {
        pattern: /\bschwarbomb\b/i,
        reply: "I knew I smelled a Schwarbomb, Tom.",
    },
    {
        pattern: /\b(trea|turner)\b/i,
        reply: "Fastest man in a Phillies uniform, Tom.",
    },
    {
        pattern: /\b(wheeler|zack)\b/i,
        reply: "He's nasty, Tom. Just flat-out nasty.",
    },
    {
        pattern: /\b(nola|aaron)\b/i,
        reply: "He's as cracked as he is jacked, Tom.",
    },
    {
        pattern: /\b(sanchez|sanchy|cris)\b/i,
        reply: "He's old school, Tom. Eats grape Uncrustables.",
    },
    {
        pattern: /\b(realmuto|jt)\b/i,
        reply: "Best catcher in baseball, Tom.",
    },
    {
        pattern: /\b(analytics|statcast|sabermetric|WAR|xFIP|wRC)\b/i,
        reply: "Analytics can kiss my butt, Tom.",
    },
    {
        pattern: /\b(cheesesteak|cheese\ssteak)\b/i,
        reply: "I just felt a disturbance in the cheesesteak, Tom.",
    },
    {
        pattern: /\b(vegan|salad|kale)\b/i,
        reply: "I ever become a vegan, would you punch me in the face, Tom?",
    },
    {
        pattern: /\b(bacon|burger|steak|food|eat)\b/i,
        reply: "You could wrap bacon around shoe leather and it would taste good, Tom.",
    },
    {
        pattern: /\b(nutella|hazelnut)\b/i,
        reply: "I don't trust Nutella cause I don't know what nut that is, Tom.",
    },
    {
        pattern: /\b(smackdown|wrestling|wwe)\b/i,
        reply: "Off day tomorrow? I want to watch Smackdown, Tom.",
    },
    {
        pattern: /\brat.?tail\b/i,
        reply: "I should grow a rat-tail? What the heck is a rat-tail, Tom?",
    },
    {
        pattern: /\bmullet\b/i,
        reply: "I miss my mullet, Tom.",
    },
    {
        pattern: /\bgood\sbot\b/i,
        reply: "Shut up, ump!",
    },
    // Fallback: any mention of Kruk's name
    {
        pattern: /\b(john\s+kruk|krukker|kruk)\b/i,
        reply: pickFallbackReply,
    },
];

const FALLBACK_REPLIES = [
    "He's now batting two thousand, Tom.",
    "He got hit in the balls? Only hurt me half as much, Tom.",
    "Her dad came out with a shotgun, trying to shoot us, Tom.",
    "I'd kiss you if these two mikes weren't in the way, Tom.",
    "I'm not going to the St. Louis Arch, Tom.",
    "I ain't an athlete, I'm a baseball player, Tom.",
    "I ever tell you about the time we played a prison team, Tom?",
    "I feel like I have tendinitis in my middle finger after driving from Florida to Philly, Tom.",
    "I hated baseball until someone decided they were going to pay me, Tom.",
    "I left and went home, turned on the game and they were wondering what happened, Tom.",
    "I opened my window there was a dang giraffe out there, Tom.",
    "Isn't JT the receiver, Tom?",
    "It takes a village to find the promised land, Tom.",
    "Not a fan of Caillou, Tom.",
    "OH MY GOD!",
    "Sorry. I said that out loud, Tom.",
    "Tell you what, these antibiotics are wonderful things, Tom.",
    "The shin bone is connected to the... Damn that hurts, Tom!",
    "There goes the best smelling man in baseball, Tom.",
    "What flavor is white cotton candy, Tom?",
    "Why aren't we born with hair on our chests as men, Tom?",
    "YEEAAHHH!",
    "You and I should have a child together, and name him Malachi, Tom.",
    "You want me to handle the rest of this inning or what?"
];

function pickFallbackReply(commentId: string): string {
    let hash = 0;
    for (const char of commentId) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return FALLBACK_REPLIES[hash % FALLBACK_REPLIES.length]!;
}

function getReply(commentBody: string, commentId: string): string | null {
    for (const { pattern, reply } of KEYWORD_REPLIES) {
        if (pattern.test(commentBody)) {
            return typeof reply === "string" ? reply : reply(commentId);
        }
    }
    return null;
}

function shouldIgnoreAuthor(username?: string | null): boolean {
    if (!username) return true;
    const lowered = username.toLowerCase();
    return lowered === "automoderator" || lowered.includes("bot");
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    await once(req, "end");
    return Buffer.concat(chunks).toString("utf8");
}

function writeJSON(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
    res.end(json);
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === "/internal/on-comment-create" && req.method === "POST") {
        await onCommentCreate(req, res);
        return;
    }
    writeJSON(res, 404, { error: "not found" });
}

async function onCommentCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const input = JSON.parse(await readBody(req)) as OnCommentCreateRequest;
    const comment = input.comment;
    const author = input.author;
    const post = input.post;

    console.log(`[krukbot] trigger fired — author:${author?.name} postTitle:${post?.title} body:${comment?.body?.slice(0, 80)}`);

    if (!comment?.id || !comment.body) {
        console.log("[krukbot] ignored: missing comment id or body");
        writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
        return;
    }

    if (!post?.title || !GAME_THREAD_REGEX.test(post.title)) {
        console.log(`[krukbot] ignored: post title did not match — "${post?.title}"`);
        writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
        return;
    }

    if (shouldIgnoreAuthor(author?.name)) {
        console.log(`[krukbot] ignored: author filtered — ${author?.name}`);
        writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
        return;
    }

    // Leaderboard command — bypasses post cooldown, no quote reply
    if (/^\s*!krukbot-leaderboard\s*$/i.test(comment.body)) {
        const alreadyRepliedKey = `krukbot:replied:${comment.id}`;
        if (await redis.get(alreadyRepliedKey)) {
            writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
            return;
        }

        const entries = await redis.zRange("krukbot:leaderboard", 0, 9, { by: "rank", reverse: true });
        const MEDALS = ["🥇", "🥈", "🥉"];
        const rows = entries.length
            ? entries.map((e, i) =>
                `${MEDALS[i] ?? `${i + 1}.`} u/${e.member} — ${e.score} ${e.score === 1 ? "mention" : "mentions"}`
              ).join("\n")
            : "No mentions yet. Say Kruk!";

        const leaderboardText =
            `**🏆 KrukBot Leaderboard — Top Kruk Callers**\n\n${rows}${BOT_DISCLAIMER}`;

        const commentTid = (comment.id.startsWith("t1_") ? comment.id : `t1_${comment.id}`) as T1;
        await reddit.submitComment({ id: commentTid, text: leaderboardText, runAs: "APP" });
        await redis.set(alreadyRepliedKey, "1");

        console.log("[krukbot] leaderboard posted");
        writeJSON(res, 200, { status: "ok" } satisfies TriggerResponse);
        return;
    }

    const replyText = getReply(comment.body, comment.id);
    if (!replyText) {
        console.log(`[krukbot] ignored: no keyword match — "${comment.body?.slice(0, 80)}"`);
        writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
        return;
    }

    if (Math.random() > 0.25) {
        console.log(`[krukbot] ignored: 25% chance roll failed`);
        writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
        return;
    }

    const postCooldownKey = `krukbot:cooldown:post:${comment.postId}`;
    const cooldownActive = await redis.get(postCooldownKey);
    if (cooldownActive) {
        console.log(`[krukbot] ignored: post cooldown active`);
        writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
        return;
    }

    const alreadyRepliedKey = `krukbot:replied:${comment.id}`;
    const alreadyReplied = await redis.get(alreadyRepliedKey);
    if (alreadyReplied) {
        console.log(`[krukbot] ignored: already replied to comment ${comment.id}`);
        writeJSON(res, 200, { status: "ignored" } satisfies TriggerResponse);
        return;
    }

    const commentTid = (comment.id.startsWith("t1_") ? comment.id : `t1_${comment.id}`) as T1;
    console.log(`[krukbot] replying to ${commentTid} with: ${replyText.slice(0, 60)}`);

    // change text line below to add disclaimer
    // text: `${replyText}${BOT_DISCLAIMER}`,
    await reddit.submitComment({
        id: commentTid,
        text: `${replyText}`,
        runAs: "APP",
    });

    console.log("[krukbot] reply posted successfully");

    await redis.set(alreadyRepliedKey, "1");

    if (author?.name) {
        await redis.zIncrBy("krukbot:leaderboard", author.name, 1);
    }

    await redis.set(postCooldownKey, "1", {
        expiration: new Date(Date.now() + 2 * 60 * 1000),
    });

    writeJSON(res, 200, { status: "ok" } satisfies TriggerResponse);
}

createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
        await onRequest(req, res);
    } catch (err) {
        console.error("[krukbot] unhandled error:", err);
        writeJSON(res, 500, { error: String(err) });
    }
}).listen(getServerPort());
