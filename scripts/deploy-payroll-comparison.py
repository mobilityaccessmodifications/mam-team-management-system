"""Target-checked comparison migration and explicit importer configuration. No mail replay."""
import hashlib,json,runpy,sys
from pathlib import Path
base=runpy.run_path(str(Path(__file__).with_name('deploy-reliability-migrations.py')))
query=base['query']; api=base['api']; literal=base['literal']
version='20260922150000'; name='payroll_comparison_alerts'
p=api('')
assert p['id']==base['PROJECT'] and p['organization_id']==base['ORG'],'Wrong MAM target'
operation=sys.argv[1]
if operation=='inspect':
 print(json.dumps(query("select count(*) as matching_active_importers from public.internal_org_people p join private.payroll_balance_import_grants g on g.person_id=p.id where p.full_name='Gerard Feril' and p.is_active and p.company_key='mam' and p.auth_user_id is not null")))
elif operation=='apply':
 sql=(base['ROOT']/'supabase/migrations'/f'{version}_{name}.sql').read_text()
 assert len(sys.argv)==3 and hashlib.sha256(sql.encode()).hexdigest()==sys.argv[2],'Reviewed migration differs'
 existing=query('select statements from supabase_migrations.schema_migrations where version='+literal(version))
 if existing: assert existing[0]['statements']==[sql],'Migration differs'
 else:
  history='insert into supabase_migrations.schema_migrations(version,name,statements) values('+literal(version)+','+literal(name)+',ARRAY['+literal(sql)+']);'
  query(sql.replace('begin;','begin; set local lock_timeout=\'5s\'; set local statement_timeout=\'60s\';',1).replace('\ncommit;','\n'+history+"\nnotify pgrst,'reload schema';\ncommit;"))
 print('Comparison migration verified')
elif operation=='configure-gerard':
 print(json.dumps(query("""do $$declare target uuid; begin
 if (select count(*) from public.internal_org_people p join private.payroll_balance_import_grants g on g.person_id=p.id where p.full_name='Gerard Feril' and p.is_active and p.company_key='mam' and p.auth_user_id is not null)<>1 then raise exception 'Expected one authorised Gerard importer';end if;
 select p.id into target from public.internal_org_people p join private.payroll_balance_import_grants g on g.person_id=p.id where p.full_name='Gerard Feril' and p.is_active and p.company_key='mam' and p.auth_user_id is not null;
 insert into private.payroll_comparison_only_importers values(target) on conflict do nothing;
 end$$;
 select count(*) as comparison_only_importers from private.payroll_comparison_only_importers;
 """)))
else: raise SystemExit('Use inspect, apply <sha256>, or configure-gerard')
