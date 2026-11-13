/**
 * Thrown when a project has `searchSettings.chat.enabled = false`. Routes map it to 403. Its own module so routes can
 * test for it without importing the chat service.
 */
export class ProjectChatDisabledError extends Error {
  readonly status = 403 as const;
  readonly code = "chat_disabled" as const;
  constructor() {
    super("Chat is turned off for this project. A project editor can turn it on in project settings.");
    this.name = "ProjectChatDisabledError";
  }
}
