-- Synthetic rows from agentops v3.2.0 audit --quiet. Import path and time normalized.
INSERT INTO "sessions" VALUES('legacy-long','capture.jsonl','agentops.event.v1','agentops-jsonl',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-01-01T00:00:00Z');
INSERT INTO "sessions" VALUES('legacy-short','capture.jsonl','agentops.event.v1','agentops-jsonl',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-01-01T00:00:00Z');
INSERT INTO "sessions" VALUES('legacy-pass','capture.jsonl','agentops.event.v1','agentops-jsonl',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-01-01T00:00:00Z');
INSERT INTO "events" VALUES(1,'legacy-long',1,'command',NULL,'bun test','052a915ecad3e47ec22a3be79599eed2e8eb654481a1911b25128a3f09d8fc58','');
INSERT INTO "events" VALUES(2,'legacy-long',2,'final_response',NULL,'Review notes. Review notes. Review notes. Review notes. Review notes. Review notes. Review notes. Review notes. Revie...','a1aa99d7998e5efe550f9c258bdb381ddfbfa4501a534300b77a623307b00a96','');
INSERT INTO "events" VALUES(3,'legacy-short',1,'command',NULL,'bun test','052a915ecad3e47ec22a3be79599eed2e8eb654481a1911b25128a3f09d8fc58','');
INSERT INTO "events" VALUES(4,'legacy-short',2,'final_response',NULL,'Tests passed.','342479d7da966f8968c82de79de609dff34859b5e566c910bd40e00591cb4d1e','');
INSERT INTO "events" VALUES(5,'legacy-pass',1,'command',NULL,'bun test','edf1ecf3d1b02c2414e0e4214d9bf61bceb555f174c9cea2d8d6d5bd6ee6e93c','');
INSERT INTO "events" VALUES(6,'legacy-pass',2,'final_response',NULL,'Tests passed.','342479d7da966f8968c82de79de609dff34859b5e566c910bd40e00591cb4d1e','');
INSERT INTO "commands" VALUES(1,'legacy-long',1,'bun test','failed',1,NULL);
INSERT INTO "commands" VALUES(2,'legacy-short',3,'bun test','failed',1,NULL);
INSERT INTO "commands" VALUES(3,'legacy-pass',5,'bun test','completed',0,NULL);
INSERT INTO "tool_calls" VALUES(1,'legacy-long',1,'shell','shell','failed');
INSERT INTO "tool_calls" VALUES(2,'legacy-short',3,'shell','shell','failed');
INSERT INTO "tool_calls" VALUES(3,'legacy-pass',5,'shell','shell','completed');
