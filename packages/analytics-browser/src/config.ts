import {
  Event,
  BrowserOptions,
  BrowserConfig as IBrowserConfig,
  DefaultTrackingOptions,
  Storage,
  TrackingOptions,
  TransportType,
  UserSession,
  Logger as ILogger,
  LogLevel,
  Plan,
  IngestionMetadata,
  IdentityStorageType,
  ServerZoneType,
} from '@amplitude/analytics-types';
import { Config, Logger, MemoryStorage, UUID } from '@amplitude/analytics-core';
import { CookieStorage, getCookieName, FetchTransport, getQueryParams } from '@amplitude/analytics-client-common';

import { LocalStorage } from './storage/local-storage';
import { XHRTransport } from './transports/xhr';
import { SendBeaconTransport } from './transports/send-beacon';
import { parseLegacyCookies } from './cookie-migration';
import { CookieOptions } from '@amplitude/analytics-types/lib/esm/config/browser';
import { DEFAULT_IDENTITY_STORAGE, DEFAULT_SERVER_ZONE } from './constants';
import { AmplitudeBrowser } from './browser-client';

// Exported for testing purposes only. Do not expose to public interface.
export class BrowserConfig extends Config implements IBrowserConfig {
  protected _cookieStorage: Storage<UserSession>;
  protected _deviceId?: string;
  protected _lastEventId?: number;
  protected _lastEventTime?: number;
  protected _optOut = false;
  protected _sessionId?: number;
  protected _userId?: string;

  constructor(
    public apiKey: string,
    public appVersion?: string,
    cookieStorage: Storage<UserSession> = new MemoryStorage(),
    public cookieOptions: CookieOptions = {
      domain: '',
      expiration: 365,
      sameSite: 'Lax' as const,
      secure: false,
      upgrade: true,
    },
    public defaultTracking: boolean | DefaultTrackingOptions = true,
    deviceId?: string,
    public flushIntervalMillis: number = 1000,
    public flushMaxRetries: number = 5,
    public flushQueueSize: number = 30,
    public identityStorage: IdentityStorageType = DEFAULT_IDENTITY_STORAGE,
    public ingestionMetadata?: IngestionMetadata,
    public instanceName?: string,
    lastEventId?: number,
    lastEventTime?: number,
    public loggerProvider: ILogger = new Logger(),
    public logLevel: LogLevel = LogLevel.Warn,
    public minIdLength?: number,
    optOut = false,
    public partnerId?: string,
    public plan?: Plan,
    public serverUrl: string = '',
    public serverZone: ServerZoneType = DEFAULT_SERVER_ZONE,
    sessionId?: number,
    public sessionTimeout: number = 30 * 60 * 1000,
    public storageProvider: Storage<Event[]> = new LocalStorage(),
    public trackingOptions: Required<TrackingOptions> = {
      ipAddress: true,
      language: true,
      platform: true,
    },
    public transport: 'fetch' | 'xhr' | 'beacon' = 'fetch',
    public useBatch: boolean = false,
    userId?: string,
  ) {
    super({ apiKey, storageProvider, transportProvider: createTransport(transport) });
    this._cookieStorage = cookieStorage;
    this.deviceId = deviceId;
    this.lastEventId = lastEventId;
    this.lastEventTime = lastEventTime;
    this.optOut = optOut;
    this.sessionId = sessionId;
    this.userId = userId;
    this.loggerProvider.enable(this.logLevel);
  }

  get cookieStorage() {
    return this._cookieStorage;
  }

  set cookieStorage(cookieStorage: Storage<UserSession>) {
    if (this._cookieStorage !== cookieStorage) {
      this._cookieStorage = cookieStorage;
      this.updateStorage();
    }
  }

  get deviceId() {
    return this._deviceId;
  }

  set deviceId(deviceId: string | undefined) {
    if (this._deviceId !== deviceId) {
      this._deviceId = deviceId;
      this.updateStorage();
    }
  }

  get userId() {
    return this._userId;
  }

  set userId(userId: string | undefined) {
    if (this._userId !== userId) {
      this._userId = userId;
      this.updateStorage();
    }
  }

  get sessionId() {
    return this._sessionId;
  }

  set sessionId(sessionId: number | undefined) {
    if (this._sessionId !== sessionId) {
      this._sessionId = sessionId;
      this.updateStorage();
    }
  }

  get optOut() {
    return this._optOut;
  }

  set optOut(optOut: boolean) {
    if (this._optOut !== optOut) {
      this._optOut = optOut;
      this.updateStorage();
    }
  }

  get lastEventTime() {
    return this._lastEventTime;
  }

  set lastEventTime(lastEventTime: number | undefined) {
    if (this._lastEventTime !== lastEventTime) {
      this._lastEventTime = lastEventTime;
      this.updateStorage();
    }
  }

  get lastEventId() {
    return this._lastEventId;
  }

  set lastEventId(lastEventId: number | undefined) {
    if (this._lastEventId !== lastEventId) {
      this._lastEventId = lastEventId;
      this.updateStorage();
    }
  }

  private updateStorage() {
    const cache = {
      deviceId: this._deviceId,
      userId: this._userId,
      sessionId: this._sessionId,
      optOut: this._optOut,
      lastEventTime: this._lastEventTime,
      lastEventId: this._lastEventId,
    };
    void this.cookieStorage.set(getCookieName(this.apiKey), cache);
  }
}

export const useBrowserConfig = async (
  apiKey: string,
  options: BrowserOptions = {},
  amplitudeInstance: AmplitudeBrowser,
): Promise<IBrowserConfig> => {
  // Step 1: Create identity storage instance
  const identityStorage = options.identityStorage || DEFAULT_IDENTITY_STORAGE;
  const cookieOptions = {
    ...options.cookieOptions,
    domain:
      identityStorage !== DEFAULT_IDENTITY_STORAGE ? '' : options.cookieOptions?.domain ?? (await getTopLevelDomain()),
    expiration: 365,
    sameSite: 'Lax' as const,
    secure: false,
    upgrade: true,
  };
  const cookieStorage = createCookieStorage<UserSession>(options.identityStorage, cookieOptions);

  // Step 1: Parse cookies using identity storage instance
  const legacyCookies = await parseLegacyCookies(apiKey, cookieStorage, options.cookieOptions?.upgrade ?? true);
  const previousCookies = await cookieStorage.get(getCookieName(apiKey));
  const queryParams = getQueryParams();

  // Step 3: Reconcile user identity
  const deviceId =
    options.deviceId ?? queryParams.deviceId ?? previousCookies?.deviceId ?? legacyCookies.deviceId ?? UUID();
  const lastEventId = previousCookies?.lastEventId ?? legacyCookies.lastEventId;
  const lastEventTime = previousCookies?.lastEventTime ?? legacyCookies.lastEventTime;
  const optOut = options.optOut ?? previousCookies?.optOut ?? legacyCookies.optOut;
  const sessionId = previousCookies?.sessionId ?? legacyCookies.sessionId;
  const userId = options.userId ?? previousCookies?.userId ?? legacyCookies.userId;
  amplitudeInstance.previousSessionDeviceId = previousCookies?.deviceId ?? legacyCookies.deviceId;
  amplitudeInstance.previousSessionUserId = previousCookies?.userId ?? legacyCookies.userId;

  const trackingOptions = {
    ...options.trackingOptions,
    ipAddress: true,
    language: true,
    platform: true,
  };

  return new BrowserConfig(
    apiKey,
    options.appVersion,
    cookieStorage,
    cookieOptions,
    options.defaultTracking,
    deviceId,
    options.flushIntervalMillis,
    options.flushMaxRetries,
    options.flushQueueSize,
    identityStorage,
    options.ingestionMetadata,
    options.instanceName,
    lastEventId,
    lastEventTime,
    options.loggerProvider,
    options.logLevel,
    options.minIdLength,
    optOut,
    options.partnerId,
    options.plan,
    options.serverUrl,
    options.serverZone,
    sessionId,
    options.sessionTimeout,
    options.storageProvider,
    trackingOptions,
    options.transport,
    options.useBatch,
    userId,
  );
};

export const createCookieStorage = <T>(
  identityStorage: IdentityStorageType = DEFAULT_IDENTITY_STORAGE,
  cookieOptions: CookieOptions = {},
) => {
  switch (identityStorage) {
    case 'localStorage':
      return new LocalStorage<T>();
    case 'none':
      return new MemoryStorage<T>();
    case 'cookie':
    default:
      return new CookieStorage<T>({
        ...cookieOptions,
        expirationDays: cookieOptions.expiration,
      });
  }
};

export const createTransport = (transport?: TransportType) => {
  if (transport === 'xhr') {
    return new XHRTransport();
  }
  if (transport === 'beacon') {
    return new SendBeaconTransport();
  }
  return new FetchTransport();
};

export const getTopLevelDomain = async (url?: string) => {
  if (!(await new CookieStorage<number>().isEnabled()) || (!url && typeof location === 'undefined')) {
    return '';
  }

  const host = url ?? location.hostname;
  const parts = host.split('.');
  const levels = [];
  const storageKey = 'AMP_TLDTEST';

  for (let i = parts.length - 2; i >= 0; --i) {
    levels.push(parts.slice(i).join('.'));
  }
  for (let i = 0; i < levels.length; i++) {
    const domain = levels[i];
    const options = { domain: '.' + domain };
    const storage = new CookieStorage<number>(options);
    await storage.set(storageKey, 1);
    const value = await storage.get(storageKey);
    if (value) {
      await storage.remove(storageKey);
      return '.' + domain;
    }
  }

  return '';
};
