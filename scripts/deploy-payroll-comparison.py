"""Target-checked comparison migration and explicit importer configuration. No mail replay."""
import hashlib,json,runpy,sys
from pathlib import Path
base=runpy.run_path(str(Path(__file__).with_name('deploy-reliability-migrations.py')))
query=base['query']; api=base['api']; literal=base['literal']
version='20260922150000'; name='payroll_comparison_alerts'
def require(condition, message):
 if not condition: raise SystemExit(message)
p=api('')
require(p.get('id')==base['PROJECT'] and p.get('organization_id')==base['ORG'],'Wrong MAM target')
operation=sys.argv[1] if len(sys.argv)>1 else ''
if operation in ['inspect','configure-importer']:
 require(len(sys.argv)==3 and 1<=len(sys.argv[2])<=160,'Supply the exact authorised importer name')
 importer=literal(sys.argv[2])
if operation=='inspect':
 print(json.dumps(query(f"select count(*) as matching_active_importers from public.internal_org_people p join private.payroll_balance_import_grants g on g.person_id=p.id where p.full_name={importer} and p.is_active and p.company_key='mam' and p.auth_user_id is not null")))
elif operation=='apply':
 sql=(base['ROOT']/'supabase/migrations'/f'{version}_{name}.sql').read_text()
 require(len(sys.argv)==3 and hashlib.sha256(sql.encode()).hexdigest()==sys.argv[2],'Reviewed migration differs')
 existing=query('select statements from supabase_migrations.schema_migrations where version='+literal(version))
 if existing: require(existing[0]['statements']==[sql],'Migration differs')
 else:
  history='insert into supabase_migrations.schema_migrations(version,name,statements) values('+literal(version)+','+literal(name)+',ARRAY['+literal(sql)+']);'
  query(sql.replace('begin;','begin; set local lock_timeout=\'5s\'; set local statement_timeout=\'60s\';',1).replace('\ncommit;','\n'+history+"\nnotify pgrst,'reload schema';\ncommit;"))
 print('Comparison migration verified')
elif operation=='configure-importer':
 print(json.dumps(query(f"""do $$declare target uuid; begin
 if (select count(*) from public.internal_org_people p join private.payroll_balance_import_grants g on g.person_id=p.id where p.full_name={importer} and p.is_active and p.company_key='mam' and p.auth_user_id is not null)<>1 then raise exception 'Expected one authorised active importer';end if;
 select p.id into target from public.internal_org_people p join private.payroll_balance_import_grants g on g.person_id=p.id where p.full_name={importer} and p.is_active and p.company_key='mam' and p.auth_user_id is not null;
 insert into private.payroll_comparison_only_importers values(target) on conflict do nothing;
 end$$;
 select count(*) as comparison_only_importers from private.payroll_comparison_only_importers;
 """)))
else: raise SystemExit('Use inspect, apply <sha256>, or configure-importer <exact name>')
