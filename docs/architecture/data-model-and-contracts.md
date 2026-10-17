# PostgreSQL model and application contracts

**Preliminary logical schema, not executable migrations.** One PostgreSQL database, one application write owner. UUIDs identify entities; timestamps use UTC `timestamptz`; cursor/version counters use `bigint`. Serialize bigint cursors as decimal strings to TypeScript. Store media bytes outside the database.

## 1. Identity and membership

| Entity | Important fields | Constraints / indexes |
|---|---|---|
| User | id, normalizedLogin, passwordHash, displayName, avatarAssetId, disabledAt, securityVersion, createdAt | Unique normalizedLogin; indexed avatar reference; ASP.NET Identity password/security fields |
| UserSession | id, userId, createdAt, lastSeenAt, idleExpiresAt, absoluteExpiresAt, revokedAt, securityVersion, deviceLabel | Index userId + revokedAt; expiry index; never store raw passwords or reusable media JWTs |
| Server | id, name, ownerUserId, policyVersion, createdAt | Restrict owner deletion; explicit owner-transfer transaction |
| ServerMember | serverId, userId, joinedAt, removedAt, memberVersion | Composite PK(serverId,userId); index(userId,serverId) |
| Role | id, serverId, name, permissionMask | Unique(serverId,name); unique(serverId,id) to support scoped FKs |
| MemberRole | serverId, userId, roleId | Composite PK; composite FKs enforce same-server membership and role |
| Invitation | id, serverId, tokenHash, createdBy, expiresAt, maxUses, usedCount, revokedAt | Unique tokenHash; CHECK 0≤usedCount≤maxUses; index(serverId,expiresAt) |
| UserSettings | userId, preferredStatus, notificationPreferences, audioPreferences, version | PK/FK userId; validated bounded JSON for preferences only |

Invitation redemption locks the invitation row and atomically validates expiry/use count, creates the account/membership, and increments usage. The token is a cryptographically random secret stored only as a hash. Default single use and 48-hour expiry; administrators may issue a bounded multi-use invite. Never infer invitation privileges from a URL parameter other than the looked-up secret. Login name and display name are distinct.

Use existing ASP.NET Core Identity tables/fields where suitable rather than recreating password storage. Account recovery initially uses admin-assisted one-use reset links plus audit and revocation of old sessions; an email sender is optional later. Admin resets never expose existing passwords.

## 2. Channels and messages

| Entity | Important fields | Constraints / indexes |
|---|---|---|
| Channel | id, serverId, type, name, position, archivedAt, nextMessageSequence, nextEventSequence, policyVersion, mediaGeneration | Unique(serverId,id); CHECK type in text/voice; index(serverId,position) |
| ChannelPermission | id, serverId, channelId, roleId nullable, memberUserId nullable, allowMask, denyMask | Exactly one subject; partial unique indexes for channel/role and channel/member; scoped FKs; allow & deny cannot overlap |
| Message | id, serverId, channelId, authorUserId, messageSequence, clientMessageId, body, replyToId, version, createdAt, editedAt, deletedAt | Unique(channelId,messageSequence); unique(authorUserId,clientMessageId); index(channelId,messageSequence DESC); index(replyToId) |
| MessageReaction | messageId, userId, emojiKey, createdAt | PK(messageId,userId,emojiKey); bounded normalized emoji string |
| FileAsset | id, serverId, ownerUserId, purpose, storageKey, mime, sizeBytes, sha256, state, createdAt, deletedAt | Unique storageKey; index(serverId,state); CHECK size≥0; purpose/state allowlists |
| MessageAttachment | messageId, fileAssetId, ordinal | Composite PK; unique(fileAssetId) for single-message ownership; index(messageId,ordinal) |
| MessageMention | messageId, mentionedUserId | Composite PK; index(mentionedUserId,messageId) |
| ChannelReadPosition | userId, channelId, lastReadMessageSequence, updatedAt | Composite PK; monotonic update; FK to user/channel |
| Notification | id, userId, type, messageId, channelId, createdAt, readAt | Dedup key by user/message/type; partial unread index on userId,createdAt |
| ChannelEvent | eventId, channelId, eventSequence, type, entityId, entityVersion, payload, committedAt, dispatchedAt | Unique(channelId,eventSequence); partial dispatch index; retention index |

`ChannelEvent` is both the synchronization log and transactional outbox. One stored event may be delivered many times. Do not use its `dispatchedAt` as proof of receipt. A background dispatcher maintains ordered processing per channel and a retry counter/backoff; permanent dispatch errors alert while HTTP history still works.

Message sequence is allocated only for creation; event sequence covers creation, edits, deletes, reactions and channel state mutations. Both counters advance under the same channel-row lock and transaction. Author-scoped client message IDs make retries across reconnects return the original result, including if the retry has a conflicting body (return conflict, never silently mutate). Requests with the same key but a different channel also conflict.

A reply FK must enforce same channel through a composite key or an equivalent transactional constraint. Attachment finalization verifies ownership, server, intended channel and ready state before linking; a file URL alone never grants attachment rights. Retain tombstones for deleted messages so a reply cannot resolve to unrelated data. No cross-workspace FK may reference a global ID without validating its server scope.

Unread counts can be queried from message sequences at this size. Exclude tombstones and respect channel visibility; gaps in sequences are harmless. PostgreSQL full-text search can be added if search becomes an MVP requirement, with language-specific expectations for Hebrew. Elasticsearch is unjustified here.

## 3. Media and soundboard

| Entity | Important fields | Constraints / indexes |
|---|---|---|
| VoiceLease | id, userId, sessionId, channelId, roomName, roomGeneration, grantedPolicyVersion, status, createdAt, lastConfirmedAt, revokedAt | Partial unique(userId) for active/joining lease; index(channelId,status); exact session linkage |
| MediaPublicationReservation | id, voiceLeaseId, kind, state, expiresAt | Unique active lease/kind; serialize installation screen/camera limits; expiry index |
| SoundboardSound | id, serverId, ownerUserId, name, emoji, durationMs, activeVersionId, state, createdAt, deletedAt | Index(serverId,state,name); CHECK duration 100–5000 ms for ready version |
| SoundAssetVersion | id, soundId, fileAssetId, version, sha256, sampleRate, channels, loudness, truePeak, createdAt | Unique(soundId,version); unique(fileAssetId); enforce canonical ready output |
| SoundboardFavorite | userId, soundId, createdAt | Composite PK; FK cascade on final sound purge |
| SoundPlaybackCommand | id, requestId, serverId, channelId, roomGeneration, voiceLeaseId, actorUserId, soundVersionId, workerEpoch, state, acceptedAt, startDeadline, startedAt, endedAt | Unique(actorUserId,requestId); indexes on state/deadline and channel/acceptedAt |
| SoundRateReservation | scopeType, scopeId, windowStart, count or accepted-command references | Update under row locks in fixed order; bounded retention; no Redis requirement |
| AssetValidationJob | id, assetId, jobType, state, attempt, createdAt, leaseExpiresAt, resultHash, errorCode | Unique active job per asset/type; index(state,createdAt) |
| AuditEvent | id, actorUserId nullable, targetType/id, action, time, outcome, redactedDetail | Index(time), index(actorUserId,time); no JWTs, raw uploads or voice contents |

**SoundboardPermission is a logical policy, not another duplicate grant table.** PlaySoundboard, UploadSoundboard, ManageOwnSounds, ManageAnySounds and StopOthersSounds are bits in Role/ChannelPermission and evaluated by the common evaluator. If a future requirement adds per-sound library ACLs, introduce a scoped SoundboardPermission table via an ADR. The initial schema must not create two disagreeing permission systems.

Playback command records are necessary for idempotency, atomic admission, expiry and restart recovery. Permanent sound-play history is not necessary for a friends' server. Purge ordinary terminal playback records after 24 hours; retain aggregate counts and actual abuse/moderation audit events for the longer audit period. Track registry/worker epoch is reconstructed from active state and verified publications; it is not an audio archive.

## 4. Effective permission algorithm

Start with membership: a removed/disabled account is denied. The owner has explicit administrative authority, subject to account disable and session revocation. For ordinary members, union base role allows. Apply channel role overrides by subtracting the union of denies and then adding non-conflicting allows, with deny winning across role overrides. Finally apply the member-specific override, with its deny winning within that override; a deliberate member allow can override a role-level deny. Document this hierarchy in the admin UI.

Require ViewChannel for all channel access. SendMessage also requires text-channel type. JoinVoice is independent of Speak, PublishCamera, ShareScreen and PlaySoundboard. Read/download of an attachment derives from its parent channel visibility. Each permission change increments policy version and triggers active connection, media-grant and playback reconciliation. Never put an indefinitely valid permission snapshot in a cookie.

## 5. REST contracts

All public routes are same-origin `/api/v1/...`. Stateful requests require authentication plus antiforgery protection, except the documented invitation/login bootstrap with its own antiforgery handling. Return RFC ProblemDetails, stable machine-readable error codes and a request ID. Bound every list and string. Prefer 401 unauthenticated, 403 denied, 404 for inaccessible objects when concealment is appropriate, 409 conflict, 413 too large, 422 invalid media and 429 throttled.

| Method/path | Request / result | Transport rationale |
|---|---|---|
| GET `/auth/csrf` | Issue XSRF bootstrap value | Same-origin before login/mutations |
| POST `/auth/register` | Invite secret, login, password, profile → session | Atomic invitation/account transaction |
| POST `/auth/login`, `/auth/logout` | Credentials / current session → cookie mutation | No tokens in localStorage |
| GET `/auth/me`, `/auth/sessions` | Profile, permissions, session list | Restore browser state |
| DELETE `/auth/sessions/{id}` | Revoke one session, including connected media | Server-side revocation |
| POST/GET/DELETE `/servers/{id}/invitations` | Create/list/revoke invitations | Owner/admin, return secret only once |
| GET/POST/PATCH `/servers/{id}/channels` | List/create/change channels | Versioned authorization and audit |
| GET `/channels/{id}/messages` | before cursor, limit → page and high-water event cursor | Offline/paginated history |
| POST `/channels/{id}/messages` | clientMessageId, body, reply, ready attachment IDs → committed message | Durable idempotent send |
| PATCH/DELETE `/messages/{id}` | Expected version, new body or tombstone | Conflict-safe edits/moderation |
| PUT/DELETE `/messages/{id}/reactions/{emoji}` | Idempotent add/remove | Durable reaction state |
| PUT `/channels/{id}/read-position` | max observed message sequence | Monotonic read position |
| GET `/channels/{id}/events` | after cursor, limit → ordered mutations | Gap recovery, explicit reset if expired |
| POST `/channels/{id}/voice/join` | requestId, prior lease if any → lease, room, short JWT, allowed media | Current permission check and admission reservation |
| POST `/voice/{leaseId}/token` | Reauthorize full reconnect → fresh scoped JWT | Never blindly refresh revoked leases |
| DELETE `/voice/{leaseId}` | Leave/revoke | Idempotent room cleanup |
| POST/DELETE `/voice/{leaseId}/publications/{kind}` | Reserve/release screen/camera capacity | Rate/concurrency policy; verify via webhooks |
| GET `/servers/{id}/sounds` | Search/favorites/cursor → metadata | No original upload disclosure |
| POST `/servers/{id}/sounds` | Multipart name/icon/file → pending sound/job | Bounded validation workflow |
| PATCH/DELETE `/sounds/{id}` | Expected version and metadata / deletion | Owner/admin authorization |
| GET `/sounds/{id}/preview` | Authorized normalized WAV; range support | Preview only, no room broadcast |
| PUT/DELETE `/sounds/{id}/favorite` | Idempotent favorite state | Private user preference |
| POST `/channels/{id}/sound-plays` | requestId, voiceLeaseId, soundId/version → playbackId and accepted state | Authoritative room playback |
| DELETE `/sound-plays/{id}` | Stop own or moderator-approved playback | Stop queue/feed and acknowledge |
| POST `/channels/{id}/sound-stop-all` | Moderator action | Emergency spam control |
| POST `/files` / GET `/files/{id}` | Upload pending file / authorized bytes | Private storage, range and size controls |
| GET/PATCH `/users/me/settings` | Preferences plus expected version | Bounded JSON, no credentials |
| GET `/notifications` | Cursor, unread filter | Recovery after offline period |

Channel/member/role administration also exposes bounded GET/POST/PATCH/DELETE routes under the server, with version checks and audit; all call the same policy service. No API accepts a caller-chosen LiveKit room name, filesystem path, worker identity, or user ID as proof of authority.

## 6. SignalR and LiveKit responsibilities

SignalR hub methods: `SubscribeChannel`, `UnsubscribeChannel`, `Typing`, `PresenceHeartbeat`, and optional `AcknowledgeCursor`. Commands that need durable results use REST. Subscriptions return a boundary cursor and policy version and are rebuilt on reconnect. Rate-limit ephemeral calls and reject unauthorized channels. State-changing hub calls must pass a hub filter that checks session and policy; hub connection authentication alone is insufficient.

SignalR events: `ChannelEvent`, `PresenceChanged`, `TypingChanged`, `PolicyChanged`, `VoiceStateChanged`, `SoundCatalogChanged`, `SoundPlaybackStateChanged`, `NotificationCreated`, `SessionRevoked`, `ServiceStatusChanged`. Ephemeral playback state includes room generation and worker epoch; old generations are discarded. A REST active-playback snapshot repairs lost UI state; it never triggers replay.

LiveKit client operations: connect/disconnect, publish/unpublish microphone/camera/screen tracks, subscribe/unsubscribe media, and collect connection statistics. No persistent text messages or authoritative soundboard commands are sent solely through LiveKit data packets. Metadata is display information unless signed/owned by the backend.

Internal-only endpoints cover worker claim/ack/state, LiveKit webhook receipt and signaling admission. Use distinct authentication schemes, narrow payloads, request deadlines and network ACLs; browser cookies never authorize worker endpoints. Signed webhook validation uses the raw request body and rejects tampering/replays before updating leases.

## 7. Deletion and retention

| Data | Policy |
|---|---|
| Messages | Keep until user/moderator deletes; keep ID/sequence tombstone, clear deleted content |
| Channel event payloads | Seven days, bounded; purge deleted message bodies promptly where present |
| Attachments | Remove links on deletion; garbage-collect unreferenced bytes after a 24-hour safety grace |
| Pending uploads | Expire after 24 hours; clean orphans even if API crashed mid-transaction |
| Sounds | Soft-delete immediately; stop active playback; purge bytes after references and grace expire |
| Sessions/invites | Remove expired secrets/records on a scheduled bounded cleanup; retain relevant audit |
| Playback commands/rate windows | Ordinary records 24 hours; active records retained until reconciled |
| Security/admin audit | 90 days, redacted; configurable |
| Logs | Seven days or fixed size budget, whichever is smaller |
| Backups | Seven daily plus four weekly encrypted copies; deletion propagates as backups expire |

Account removal initially disables access and anonymizes retained message authors rather than cascading away community history. A workspace delete is an explicit administrative operation with an export/backup decision and cascading cleanup job; never expose it through ordinary membership removal. Referential integrity and garbage collection must be tested against interruption, not assumed from happy-path API code.
