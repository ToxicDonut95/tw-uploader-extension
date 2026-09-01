globalThis.TD = {
  API_BASE: 'https://api.toxicdonut.dev',
  MessageType: {
    Upload: 1,
    RequestAccess: 2,
    VerifyAccount: 3,
    ReRequestAccess: 4,
    FlushQueue: 5
  },
  UploadStatus: {
    Pending: 1,
    Uploading: 2,
    Done: 3,
    Failed: 4,
    NoAccount: 5
  },
  AccountStatus: {
    Unverified: 1,
    PendingVerification: 2,
    Verified: 3,
    Expired: 4
  },
  AccessStatus: {
    Pending: 1,
    Verified: 2,
    Expired: 3
  },
  StorageKeys: {
    Queue: 'queue',
    Accounts: 'accounts',
    Settings: 'settings',
    Log: 'log'
  },
  BackoffMs: [30000, 120000, 600000, 1800000],
  MaxQueueItems: 200,
  MaxLogItems: 100
};
