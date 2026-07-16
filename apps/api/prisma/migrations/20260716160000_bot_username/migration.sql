-- Store the connected bot's @username (public) for building t.me links.
ALTER TABLE "Client" ADD COLUMN "telegramBotUsername" TEXT;
