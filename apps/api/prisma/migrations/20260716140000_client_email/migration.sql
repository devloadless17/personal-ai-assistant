-- Client self-service portal: the client's Gmail (admin-assigned), unique.
ALTER TABLE "Client" ADD COLUMN "email" TEXT;
CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");
