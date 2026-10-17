# Architecture diagrams

Eleven requested views follow. View 5 is split into three ER diagrams to keep it readable. Solid media arrows identify real audio/video; control messages are labeled separately. The schema document supplies fields and constraints omitted from these logical views. Every diagram is also supplied as a standalone `.mmd` source and rendered SVG in `diagrams/`.

## 1. System context

```mermaid
flowchart TB
    Friends["15 invited friends"] --> Browser["Browser application"]
    Admin["Community administrator"] --> Browser
    Browser -->|"Text and account actions"| Platform["Private communication platform"]
    Browser <-->|"Voice, screens, cameras and effects"| Platform
    Admin -->|"Operate and restore"| Host["One VPS"]
    Host -->|"Runs"| Platform
    Platform -->|"Encrypted backup"| Backup["Independent backup destination"]
    DNS["DNS and certificate authority"] -->|"Name and TLS trust"| Browser
    DNS -->|"Certificate issuance"| Host
```

## 2. Container and component architecture

```mermaid
flowchart TB
    Web["Angular browser"] -->|"HTTPS and WSS"| Edge["Caddy HTTP and Layer 4"]
    Edge -->|"API and SignalR"| API["ASP.NET modular monolith"]
    Edge -->|"Static build"| SPA["Angular assets"]
    Edge -->|"Gated signaling or TURN"| LK["LiveKit SFU and TURN"]
    Web <-->|"WebRTC media"| LK
    API --> DB[("PostgreSQL")]
    API --> Files[("Private files and job spool")]
    Validator["Restricted asset validator"] <-->|"Jobs and validated files"| Files
    API -->|"Authorized play or stop"| Publisher["Sound RTC publisher"]
    Files -->|"Ready PCM only"| Publisher
    Publisher -->|"Real Opus audio tracks"| LK
    API <-->|"RoomService and verified webhooks"| LK
    API -->|"Track registry and UI events"| Web
```

## 3. Angular frontend architecture

```mermaid
flowchart TB
    Shell["Persistent AppShell"] --> Router["Lazy route outlet"]
    Shell --> Dock["Voice dock and playback host"]
    Router --> Chat["Messages and channel UI"]
    Router --> Settings["Settings and administration"]
    Dock --> Panel["Soundboard panel"]
    Chat --> AppState["Session and channel stores"]
    Settings --> AppState
    Panel --> Sounds["Root soundboard store"]
    Dock --> Media["Root MediaSessionService"]
    Sounds --> HTTP["Typed HTTP and SignalR adapters"]
    AppState --> HTTP
    Media --> SDK["LiveKit and capture adapter"]
    SDK --> Mixer["Root audio output and track registry"]
    Sounds --> Mixer
    Mixer --> Dock
```

## 4. Backend module architecture

```mermaid
flowchart TB
    Entry["REST endpoints and SignalR hub"] --> Auth["Identity and sessions"]
    Entry --> Commands["Application services"]
    Auth --> Policy["Shared permission evaluator"]
    Commands --> Policy
    Commands --> Community["Users, servers and channels"]
    Commands --> Messaging["Messages and notifications"]
    Commands --> Media["Media coordination and soundboard"]
    Community --> DB[("PostgreSQL")]
    Messaging --> DB
    Media --> DB
    Messaging --> Files["File management"]
    Media --> Files
    DB --> Outbox["Event dispatch and reconciliation"]
    Outbox --> Entry
    Media --> Adapter["LiveKit and publisher adapters"]
    Files --> Validator["Restricted validation adapter"]
    Entry --> Presence["Ephemeral presence registry"]
    Policy --> Outbox
```

## 5a. ER model — access

```mermaid
erDiagram
    direction TB
    User ||--o{ UserSession : owns
    User ||--o{ ServerMember : joins
    User ||--|| UserSettings : configures
    Server ||--o{ ServerMember : contains
    Server ||--o{ Invitation : issues
    Server ||--o{ Role : defines
    Server ||--o{ Channel : contains
    ServerMember ||--o{ MemberRole : receives
    Role ||--o{ MemberRole : grants
    Channel ||--o{ ChannelPermission : overrides
    Role o|--o{ ChannelPermission : targets
    ServerMember o|--o{ ChannelPermission : targets
    User {
        uuid id PK
        string normalizedLogin UK
        string passwordHash
        bigint securityVersion
    }
    UserSession {
        uuid id PK
        uuid userId FK
        datetime revokedAt
        datetime absoluteExpiresAt
    }
    Server {
        uuid id PK
        uuid ownerUserId FK
        bigint policyVersion
    }
    Channel {
        uuid id PK
        uuid serverId FK
        string type
        bigint policyVersion
    }
```

## 5b. ER model — messaging

```mermaid
erDiagram
    direction TB
    Channel ||--o{ Message : contains
    Channel ||--o{ ChannelEvent : orders
    Channel ||--o{ ChannelReadPosition : tracks
    User ||--o{ Message : authors
    User ||--o{ ChannelReadPosition : reads
    Message o|--o{ Message : replies
    Message ||--o{ MessageReaction : receives
    Message ||--o{ MessageAttachment : attaches
    FileAsset ||--o| MessageAttachment : backs
    Message ||--o{ MessageMention : mentions
    Message ||--o{ Notification : triggers
    User ||--o{ Notification : receives
    Message {
        uuid id PK
        uuid channelId FK
        uuid authorUserId FK
        bigint messageSequence
        uuid clientMessageId
        bigint version
    }
    ChannelEvent {
        uuid eventId PK
        uuid channelId FK
        bigint eventSequence
        string type
        datetime dispatchedAt
    }
    FileAsset {
        uuid id PK
        string storageKey UK
        string state
        bigint sizeBytes
    }
```

## 5c. ER model — media and soundboard

```mermaid
erDiagram
    direction TB
    UserSession ||--o{ VoiceLease : authorizes
    Channel ||--o{ VoiceLease : hosts
    VoiceLease ||--o{ MediaPublicationReservation : reserves
    Server ||--o{ SoundboardSound : owns
    User ||--o{ SoundboardSound : uploads
    SoundboardSound ||--o{ SoundAssetVersion : versions
    FileAsset ||--o| SoundAssetVersion : stores
    FileAsset ||--o{ AssetValidationJob : validates
    User ||--o{ SoundboardFavorite : favorites
    SoundboardSound ||--o{ SoundboardFavorite : selected
    VoiceLease ||--o{ SoundPlaybackCommand : requests
    SoundAssetVersion ||--o{ SoundPlaybackCommand : plays
    VoiceLease {
        uuid id PK
        uuid sessionId FK
        uuid channelId FK
        string roomName
        string status
    }
    SoundPlaybackCommand {
        uuid id PK
        uuid voiceLeaseId FK
        uuid soundVersionId FK
        uuid requestId
        string workerEpoch
        string state
    }
```

## 6. Authentication sequence

```mermaid
sequenceDiagram
    participant B as Angular browser
    participant A as ASP.NET API
    participant D as PostgreSQL
    participant H as SignalR
    participant M as Media coordinator
    B->>A: Get antiforgery bootstrap
    A-->>B: XSRF token
    B->>A: Login with credentials and XSRF
    A->>D: Verify account and create session
    D-->>A: Active session ID
    A-->>B: Secure HttpOnly cookie
    B->>H: Connect using same-origin cookie
    H->>D: Validate session
    H-->>B: Connected
    B->>A: Revoke session
    A->>D: Mark revoked and revoke voice leases
    A->>H: Remove recipients and close connection
    A->>M: Remove live media participant
    A-->>B: Clear cookie
```

## 7. Voice-channel join sequence

```mermaid
sequenceDiagram
    participant B as Angular media service
    participant A as API and database
    participant G as Caddy admission gate
    participant L as LiveKit
    participant W as Sound publisher
    B->>A: Join channel with session and request ID
    A->>A: Check policy and reserve voice lease
    A->>L: Ensure room exists
    A-->>B: Scoped JWT and lease
    B->>G: Open RTC signaling with JWT
    G->>A: Verify token, session, lease and current grants
    A-->>G: Allow or deny
    G->>L: Forward authorized signaling
    L-->>B: Establish ICE and DTLS-SRTP
    B->>L: Publish authorized microphone
    L->>A: Verified participant event
    A->>W: Ensure publish-only room participant
    Note over B,L: Reconnect signaling passes admission again
```

## 8. Screen sharing with system audio

```mermaid
sequenceDiagram
    participant U as User and browser picker
    participant A as Angular capture service
    participant P as API policy
    participant L as LiveKit
    participant V as Remote viewers
    U->>A: Click share
    A->>U: getDisplayMedia with source and audio hints
    U-->>A: User-selected video and optional audio
    A->>A: Inspect tracks and check feedback-safe mode
    A->>P: Reserve allowed screen publication
    P-->>A: Allow or deny
    alt Audio captured and safe mode certified
        A->>L: Publish screen video and separate screen audio
        L->>V: Forward selected video layer and real audio
    else Audio unavailable or unsafe
        A-->>U: Offer video-only or explicit fallback
        A->>L: Publish video only after consent
        L->>V: Forward selected video layer
    end
    U->>A: Stop sharing or revoke capture
    A->>L: Unpublish screen video and audio
    A->>P: Release publication reservation
```

## 9. Soundboard playback sequence

```mermaid
sequenceDiagram
    participant C as Clicking browser
    participant A as API and database
    participant P as Sound RTC publisher
    participant L as LiveKit SFU
    participant R as Every authorized listener
    C->>A: Play sound with lease and request ID
    A->>A: Check membership, permission, rate and capacity
    A->>A: Commit accepted command with deadline
    A-->>C: Accepted playback ID
    A->>P: Start approved immutable sound version
    P->>L: Ensure separate audio track for actor
    P->>A: Register track SID and actor mapping
    A-->>R: Track registry and playback state
    P->>P: Read normalized PCM into bounded AudioSource
    P->>L: Publish real Opus audio frames
    L->>R: Forward real audio to all subscribed listeners
    Note over C,R: Clicker is also a listener, no duplicate local play
    R->>R: Actor mute, sound volume, limiter and output
    C->>A: Stop playback
    A->>P: Cancel feed and clear queue
    P->>L: End audio and mute idle publication
    A-->>R: Stopped state
```

## 10. Sound upload and validation

```mermaid
sequenceDiagram
    participant B as Angular upload dialog
    participant A as API and database
    participant F as Private file volumes
    participant V as Isolated validator
    B->>B: Local preview when decoding is supported
    B->>A: Upload bounded sound and metadata
    A->>A: Authorize upload and reserve quota
    A->>F: Write quarantine file and trusted job descriptor
    A-->>B: Pending asset ID
    V->>F: Read next job and input
    V->>V: Bounded decode, normalize and verify
    alt Valid sound
        V->>F: Atomically write canonical WAV and result
        A->>F: Verify output path, hash and limits
        A->>A: Mark immutable version ready
        A-->>B: Ready event and normalized preview
    else Invalid or timed out
        V->>F: Failure result and cleanup
        A->>A: Mark rejected and release quota
        A-->>B: Clear validation error
    end
```

## 11. Deployment and network architecture

```mermaid
flowchart TB
    Internet["Friends on Israeli networks"] -->|"TCP 443"| Edge["Caddy Layer 4 and HTTP"]
    Internet <-->|"UDP 7882 or TCP 7881"| Media["LiveKit host-network media"]
    Internet <-->|"UDP 3478"| Turn["Embedded TURN"]
    subgraph VPS["Single Ubuntu VPS"]
        Edge -->|"App HTTPS and SignalR"| API["Private API listener"]
        Edge -->|"RTC handshake"| Gate["Application admission check"]
        Gate -->|"Authorized signaling"| Media
        Edge <-->|"TURN hostname on TCP 443"| Turn
        Turn <--> Media
        API --> DB[("Private PostgreSQL")]
        API --> Disk[("Persistent files and keys")]
        API --> Worker["Sound publisher"]
        Disk --> Worker
        Worker -->|"Local RTC audio"| Media
        Validate["Validator without network"] <--> Disk
    end
    Disk -->|"Encrypted scheduled backup"| Backup["Independent backup destination"]
    DB -->|"Consistent dump"| Backup
```
