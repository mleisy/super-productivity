import {Injectable} from '@angular/core';
import {GlobalConfigService} from '../config/global-config.service';
import {combineLatest, Observable} from 'rxjs';
import {DropboxSyncConfig} from '../config/global-config.model';
import {concatMap, distinctUntilChanged, first, map, take, tap} from 'rxjs/operators';
import {DropboxApiService} from './dropbox-api.service';
import {DROPBOX_SYNC_FILE_PATH} from './dropbox.const';
import {AppDataComplete} from '../../imex/sync/sync.model';
import {SyncService} from '../../imex/sync/sync.service';
import {DataInitService} from '../../core/data-init/data-init.service';
import {
  LS_DROPBOX_LAST_LOCAL_REVISION,
  LS_DROPBOX_LOCAL_LAST_SYNC,
  LS_DROPBOX_LOCAL_LAST_SYNC_CHECK
} from '../../core/persistence/ls-keys.const';
import {DropboxConflictResolution, DropboxFileMetadata} from './dropbox.model';
import {DataImportService} from '../../imex/sync/data-import.service';
import {checkForUpdate, UpdateCheckResult} from '../../imex/sync/check-for-update.util';
import {dbxLog} from './dropbox-log.util';
import {MatDialog} from '@angular/material/dialog';
import {DialogDbxSyncConflictComponent} from './dialog-dbx-sync-conflict/dialog-dbx-sync-conflict.component';


@Injectable({
  providedIn: 'root'
})
export class DropboxSyncService {
  dropboxCfg$: Observable<DropboxSyncConfig> = this._globalConfigService.cfg$.pipe(
    map(cfg => cfg.dropboxSync)
  );
  isEnabled$: Observable<boolean> = this.dropboxCfg$.pipe(
    map(cfg => cfg && cfg.isEnabled),
  );
  syncInterval$: Observable<number> = this.dropboxCfg$.pipe(
    map(cfg => cfg && cfg.syncInterval),
    distinctUntilChanged(),
  );

  isEnabledAndReady$ = this._dataInitService.isAllDataLoadedInitially$.pipe(
    concatMap(() => combineLatest([
      this._dropboxApiService.isTokenAvailable$,
      this.isEnabled$,
    ])),
    map(([isTokenAvailable, isEnabled]) => isTokenAvailable && isEnabled),
    distinctUntilChanged(),
  );

  private _isReadyForRequests$ = this.isEnabledAndReady$.pipe(
    tap((isReady) => !isReady && new Error('Dropbox Sync not ready')),
    first(),
  );

  constructor(
    private _globalConfigService: GlobalConfigService,
    private _dataImportService: DataImportService,
    private _syncService: SyncService,
    private _dropboxApiService: DropboxApiService,
    private _dataInitService: DataInitService,
    private _matDialog: MatDialog,
  ) {
    // TODO initial syncing (do with immediate triggers)
  }

  async sync() {
    await this._isReadyForRequests$.toPromise();

    this._updateLocalLastSyncCheck();

    const {rev, clientUpdate} = await this._getRevAndLastClientUpdate();
    const lastSync = this._getLocalLastSync();

    let local: AppDataComplete;
    const localRev = this._getLocalRev();

    if (rev === localRev) {
      dbxLog('DBX PRE1: ↔ Same Rev');
      local = await this._syncService.inMemory$.pipe(take(1)).toPromise();
      if (lastSync === local.lastLocalSyncModelChange) {
        dbxLog('DBX PRE1: No local changes to sync');
        return;
      }
    }
    // if not defined yet
    local = local || await this._syncService.inMemory$.pipe(take(1)).toPromise();

    // NOTE: missing milliseconds :(
    const remoteClientUpdate = clientUpdate / 1000;
    // NOTE: not 100% an exact science, but changes occurring at the same time
    // getting lost, might be unlikely and ok after all
    // local > remote && lastSync >= remote &&  lastSync < local
    if (
      Math.floor(local.lastLocalSyncModelChange / 1000) > remoteClientUpdate
      && remoteClientUpdate === Math.floor(lastSync / 1000)
      && lastSync < local.lastLocalSyncModelChange
    ) {
      dbxLog('DBX PRE2: ↑ Update Remote');
      return await this._uploadAppData(local);
    }

    const r = (await this._downloadAppData());
    const remote = r.data;
    const p = {
      local: local.lastLocalSyncModelChange,
      lastSync,
      remote: remote.lastLocalSyncModelChange
    };

    switch (checkForUpdate(p)) {
      case UpdateCheckResult.InSync: {
        dbxLog('DBX: ↔ In Sync => No Update');
        break;
      }

      case UpdateCheckResult.LocalUpdateRequired: {
        dbxLog('DBX: ↓ Update Local');
        return await this._importData(remote, r.meta.rev);
      }

      case UpdateCheckResult.RemoteUpdateRequired: {
        dbxLog('DBX: ↑ Update Remote');
        return await this._uploadAppData(local);
      }

      case UpdateCheckResult.DataDiverged: {
        dbxLog('^--------^-------^');
        dbxLog('DBX: ⇎ X Diverged Data');
        const dr = await this._openConflictDialog(p).toPromise();
        if (dr === 'REMOTE') {
          dbxLog('DBX: Dialog => ↑ Remote Update');
          return await this._uploadAppData(local);
        } else if (dr === 'LOCAL') {
          dbxLog('DBX: Dialog => ↓ Update Local');
          return await this._importData(remote, r.meta.rev);
        }
        break;
      }

      case UpdateCheckResult.LastSyncNotUpToDate: {
        this._setLocalLastSync(local.lastLocalSyncModelChange);
      }
    }
  }

  private async _importData(data: AppDataComplete, rev: string) {
    if (!data) {
      const r = (await this._downloadAppData());
      data = r.data;
      rev = r.meta.rev;
    }
    if (!rev) {
      throw new Error('No rev given');
    }

    await this._dataImportService.importCompleteSyncData(data);
    this._setLocalRev(rev);
    this._setLocalLastSync(data.lastLocalSyncModelChange);
    dbxLog('DBX: ↓ Imported Data ↓ ✓');
  }

  // NOTE: this does not include milliseconds, which could lead to uncool edge cases... :(
  private async _getRevAndLastClientUpdate(): Promise<{ rev: string; clientUpdate: number }> {
    const r = await this._dropboxApiService.getMetaData(DROPBOX_SYNC_FILE_PATH);
    const d = new Date(r.client_modified);
    return {
      clientUpdate: d.getTime(),
      rev: r.rev,
    };
  }

  private _downloadAppData(): Promise<{ meta: DropboxFileMetadata, data: AppDataComplete }> {
    return this._dropboxApiService.download<AppDataComplete>({
      path: DROPBOX_SYNC_FILE_PATH,
      localRev: this._getLocalRev(),
    });
  }

  private async _uploadAppData(data: AppDataComplete): Promise<DropboxFileMetadata> {
    const r = await this._dropboxApiService.upload({
      path: DROPBOX_SYNC_FILE_PATH,
      data,
      clientModified: data.lastLocalSyncModelChange,
    });
    this._setLocalRev(r.rev);
    this._setLocalLastSync(data.lastLocalSyncModelChange);
    dbxLog('DBX: ↑ Uploaded Data ↑ ✓');
    return r;
  }


  // LS HELPER
  // ---------
  private _getLocalRev(): string {
    return localStorage.getItem(LS_DROPBOX_LAST_LOCAL_REVISION);
  }

  private _setLocalRev(rev: string) {
    if (!rev) {
      throw new Error('No rev given');
    }

    return localStorage.setItem(LS_DROPBOX_LAST_LOCAL_REVISION, rev);
  }

  private _getLocalLastSync(): number {
    const it = +localStorage.getItem(LS_DROPBOX_LOCAL_LAST_SYNC);
    return isNaN(it)
      ? 0
      : it;
  }

  private _setLocalLastSync(localLastSync: number) {
    if (typeof localLastSync !== 'number') {
      throw new Error('No correct localLastSync given');
    }
    return localStorage.setItem(LS_DROPBOX_LOCAL_LAST_SYNC, localLastSync.toString());
  }

  private _updateLocalLastSyncCheck() {
    localStorage.setItem(LS_DROPBOX_LOCAL_LAST_SYNC_CHECK, Date.now().toString());
  }

  private _openConflictDialog({remote, local, lastSync}: { remote: number, local: number, lastSync: number }): Observable<DropboxConflictResolution> {
    return this._matDialog.open(DialogDbxSyncConflictComponent, {
      restoreFocus: true,
      data: {
        remote,
        local,
        lastSync,
      }
    }).afterClosed();
  }

}