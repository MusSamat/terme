# Восстановление из резервных копий (Runbook)

Кратко: где лежат бэкапы, как восстановить БД и файлы, как настроить offsite.

## Где создаются бэкапы

Два cron-джоба (`src/cron/jobs/`):

- **`db_backup`** — ежедневно в 03:00. `pg_dump -Fc` (custom format, сжатый,
  восстанавливается через `pg_restore`) → `$BACKUP_DIR/db/pg-<timestamp>.dump`.
- **`files_backup`** — ежедневно в 04:00. `rsync -a --delete` каталога загрузок
  `$FILES_DIR` → `$BACKUP_DIR/files/`.

Оба джоба **no-op**, пока не задан `BACKUP_DIR` (в dev/CI ничего не пишется).
На staging/prod задайте `BACKUP_DIR` в env, иначе бэкапов НЕ будет.
Старые дампы БД удаляются по `BACKUP_RETENTION_DAYS` (по умолчанию 30 дней).

Проверить, что бэкапы идут:

```bash
ls -lh "$BACKUP_DIR/db"      # свежие pg-*.dump
ls -lh "$BACKUP_DIR/files"   # зеркало каталога загрузок
```

## Восстановление БД

1. **Остановите приложение** (чтобы не было записи во время восстановления):

   ```bash
   pm2 stop all        # или: systemctl stop terme-api  /  docker compose stop api
   ```

2. Выберите нужный дамп:

   ```bash
   ls -t "$BACKUP_DIR/db"/pg-*.dump | head
   DUMP="$BACKUP_DIR/db/pg-2026-09-23T03-00-00-000Z.dump"
   ```

3. Восстановите. Вариант A — в чистую БД (рекомендуется):

   ```bash
   # Пересоздать целевую БД
   psql "$DATABASE_URL_ADMIN" -c 'DROP DATABASE IF EXISTS kosho;'
   psql "$DATABASE_URL_ADMIN" -c 'CREATE DATABASE kosho OWNER kosho;'

   # Восстановить дамп custom-формата
   pg_restore --no-owner --no-privileges \
     -d "postgresql://kosho:PASS@HOST:5432/kosho" \
     "$DUMP"
   ```

   Вариант B — поверх существующей БД (осторожно, данные будут заменены):

   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges \
     -d "postgresql://kosho:PASS@HOST:5432/kosho" \
     "$DUMP"
   ```

4. **Проверьте схему** — дамп мог быть снят до последних миграций:

   ```bash
   npx prisma migrate deploy   # применит недостающие миграции, идемпотентно
   ```

5. Запустите приложение и проверьте здоровье:

   ```bash
   pm2 start all       # или systemctl start terme-api
   curl -fsS http://localhost:3000/health
   ```

## Восстановление файлов

Зеркало `rsync` кладётся в `$BACKUP_DIR/files/`. Вернуть его на место:

```bash
# Остановите приложение, затем скопируйте файлы обратно в FILES_DIR
rsync -a --delete "$BACKUP_DIR/files/" "$FILES_DIR/"
```

`--delete` приведёт `FILES_DIR` в точное соответствие бэкапу (удалит лишнее).
Если нужно только добавить недостающие файлы, уберите `--delete`.

## Offsite (рекомендуется)

Локальные бэкапы не спасают при потере сервера. Настройте выгрузку в S3 /
объектное хранилище через `rclone` отдельным cron (например, в 05:00, после
db_backup и files_backup):

```cron
# /etc/cron.d/terme-offsite
0 5 * * *  terme  rclone sync "$BACKUP_DIR" remote:terme-backups --transfers 4 >> /var/log/terme-offsite.log 2>&1
```

где `remote:` — заранее настроенный remote (`rclone config`) на S3 / Backblaze
B2 / Google Cloud Storage. Включите на бакете versioning и retention, чтобы
пережить случайное удаление или ransomware.
