import { extname } from "node:path";
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import sharp from "sharp";

const imagePrefix = "Image file (read at request time): ";
const read = createReadTool();
export const ImageRead = defineExtension({
	name: "image-read",
	tools: [
		defineTool({
			...read,
			description: `${read.description} Images are kept as file references and resized at request time.`,
			async execute(args, api, context) {
				if (
					![".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"].includes(
						extname(args.path).toLowerCase(),
					)
				) {
					return read.execute(args, api, context);
				}
				if (!api.env) throw new Error("No image filesystem");
				const path = getOrThrow(await api.env.canonicalPath(args.path, context));
				return { content: [{ type: "text", text: imagePrefix + JSON.stringify(path) }] };
			},
		}),
	],
	hooks: [
		hook(GenerationTask, {
			async beforeRequest(request) {
				const messages = await Promise.all(
					request.messages.map(async (message) => {
						if (message.role !== "toolResult" || message.toolName !== "read") return message;
						const reference = message.content.find(
							(part) => part.type === "text" && part.text.startsWith(imagePrefix),
						);
						if (reference?.type !== "text") return message;
						const path: unknown = JSON.parse(reference.text.slice(imagePrefix.length));
						if (typeof path !== "string") return message;
						try {
							const bytes = await sharp(path)
								.rotate()
								.resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
								.jpeg({ quality: 75 })
								.toBuffer();
							return {
								...message,
								content: [
									...message.content,
									{ type: "image" as const, data: bytes.toString("base64"), mimeType: "image/jpeg" },
								],
							};
						} catch {
							return {
								...message,
								isError: true,
								content: [{ type: "text" as const, text: `Image is no longer available: ${path}` }],
							};
						}
					}),
				);
				return { messages };
			},
		}),
	],
});
