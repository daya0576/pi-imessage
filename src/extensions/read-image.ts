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
				return {
					content: [{ type: "text", text: imagePrefix + JSON.stringify(path) }],
					details: { imagePath: path },
				};
			},
		}),
	],
	hooks: [
		hook(GenerationTask, {
			async beforeRequest(request) {
				const messages = await Promise.all(
					request.messages.map(async (message) => {
						if (message.role !== "toolResult" || message.toolName !== "read") return message;
						// Only trusted tool metadata is a reference; plain file text must not impersonate one.
						const details = message.details;
						if (!details || typeof details !== "object" || !("imagePath" in details)) return message;
						const path = details.imagePath;
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
						} catch (error) {
							return {
								...message,
								isError: true,
								content: [
									{
										type: "text" as const,
										text: `Image read failed: ${path} (${error instanceof Error ? error.message : String(error)})`,
									},
								],
							};
						}
					}),
				);
				return { messages };
			},
		}),
	],
});
