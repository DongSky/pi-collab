import { deliverMail } from "../../../lib/collab/mail";

await deliverMail({ to: "recipient@test.invalid", subject: "Collab TLS fixture", text: "Fixed local delivery fixture" });
