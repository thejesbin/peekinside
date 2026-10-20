import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import PeekInside from "peekinside";

class AppModule {}
Module({})(AppModule);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  PeekInside.attach(app);
  await app.listen(3000);

  // A worker: create PeekInside first, attach once Nest has made the context.
  const peekInside = new PeekInside();
  const worker = await NestFactory.createApplicationContext(AppModule);
  peekInside.attachTo(worker);
}
void bootstrap();
