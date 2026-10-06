-- Synthetic CI platform structure only; no Storage or employee rows.
-- Source storage-21-guard-context.private.json SHA256 e786c1bd999d08a22a6f4bf4ad11adc66d5065463c18da99c05b64cd41b2e904.
begin;
do $$ begin assert current_database() ~ '^mam_test_'; end $$;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='supabase_storage_admin') then
    create role supabase_storage_admin nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
set local search_path = '';
create type storage.buckettype as enum ('STANDARD', 'ANALYTICS', 'VECTOR');
alter type storage.buckettype owner to supabase_storage_admin;
create table storage."buckets_analytics" (
  "name" text collate "default" not null,
  "type" storage.buckettype default 'ANALYTICS'::storage.buckettype not null,
  "format" text collate "default" default 'ICEBERG'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "id" uuid default gen_random_uuid() not null,
  "deleted_at" timestamp with time zone,
  constraint "buckets_analytics_pkey" PRIMARY KEY (id)
);
alter table storage."buckets_analytics" owner to supabase_storage_admin;
CREATE UNIQUE INDEX buckets_analytics_unique_name_idx ON storage.buckets_analytics USING btree (name) WHERE (deleted_at IS NULL);
create table storage."buckets_vectors" (
  "id" text collate "default" not null,
  "type" storage.buckettype default 'VECTOR'::storage.buckettype not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  constraint "buckets_vectors_pkey" PRIMARY KEY (id)
);
alter table storage."buckets_vectors" owner to supabase_storage_admin;
create table storage."migrations" (
  "id" integer not null,
  "name" character varying(100) collate "default" not null,
  "hash" character varying(40) collate "default" not null,
  "executed_at" timestamp without time zone default CURRENT_TIMESTAMP,
  constraint "migrations_name_key" UNIQUE (name),
  constraint "migrations_pkey" PRIMARY KEY (id)
);
alter table storage."migrations" owner to supabase_storage_admin;
create table storage."s3_multipart_uploads" (
  "id" text collate "default" not null,
  "in_progress_size" bigint default 0 not null,
  "upload_signature" text collate "default" not null,
  "bucket_id" text collate "default" not null,
  "key" text collate "C" not null,
  "version" text collate "default" not null,
  "owner_id" text collate "default",
  "created_at" timestamp with time zone default now() not null,
  "user_metadata" jsonb,
  "metadata" jsonb,
  constraint "s3_multipart_uploads_bucket_id_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id),
  constraint "s3_multipart_uploads_pkey" PRIMARY KEY (id)
);
alter table storage."s3_multipart_uploads" owner to supabase_storage_admin;
CREATE INDEX idx_multipart_uploads_list ON storage.s3_multipart_uploads USING btree (bucket_id, key, created_at);
create table storage."s3_multipart_uploads_parts" (
  "id" uuid default gen_random_uuid() not null,
  "upload_id" text collate "default" not null,
  "size" bigint default 0 not null,
  "part_number" integer not null,
  "bucket_id" text collate "default" not null,
  "key" text collate "C" not null,
  "etag" text collate "default" not null,
  "owner_id" text collate "default",
  "version" text collate "default" not null,
  "created_at" timestamp with time zone default now() not null,
  constraint "s3_multipart_uploads_parts_bucket_id_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id),
  constraint "s3_multipart_uploads_parts_pkey" PRIMARY KEY (id),
  constraint "s3_multipart_uploads_parts_upload_id_fkey" FOREIGN KEY (upload_id) REFERENCES storage.s3_multipart_uploads(id) ON DELETE CASCADE
);
alter table storage."s3_multipart_uploads_parts" owner to supabase_storage_admin;
create table storage."vector_indexes" (
  "id" text collate "default" default gen_random_uuid() not null,
  "name" text collate "C" not null,
  "bucket_id" text collate "default" not null,
  "data_type" text collate "default" not null,
  "dimension" integer not null,
  "distance_metric" text collate "default" not null,
  "metadata_configuration" jsonb,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  constraint "vector_indexes_bucket_id_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets_vectors(id),
  constraint "vector_indexes_pkey" PRIMARY KEY (id)
);
alter table storage."vector_indexes" owner to supabase_storage_admin;
CREATE UNIQUE INDEX vector_indexes_name_bucket_id_idx ON storage.vector_indexes USING btree (name, bucket_id);
commit;
