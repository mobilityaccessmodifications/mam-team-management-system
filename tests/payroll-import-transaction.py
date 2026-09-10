"""Emit a rollback-only synthetic test of the exact versioned import transaction."""
import ast,json,pathlib,uuid,sys
script=ast.parse((pathlib.Path(__file__).resolve().parents[1]/'scripts/import-payroll-balances-20260910.py').read_text())
sql=next(n.value for n in ast.walk(script) if isinstance(n,ast.Constant) and isinstance(n.value,str) and 'create temp table task_payroll_rows' in n.value)
rows=[]; fixtures=[]
for i in range(28):
    name=f'Synthetic Payroll {i+1}'
    person=str(uuid.UUID(int=1000+i)) if i<19 else None
    status='linked' if i<18 else 'inactive' if i==18 else 'unmatched'
    row=dict(company_key='mam',employee_name=name,annual_hours=51.3552,sick_hours=80.7246,as_of='2026-09-10',source_file='synthetic.xlsx',source_sha256='b'*64,person_id=person,match_status=status)
    rows.append(row)
    if person:
        fixtures.append(f"insert into public.internal_org_people(id,full_name,company_key,position_title,is_active) values('{person}','{name}','mam','Synthetic test',{str(i<18).lower()});")
fixtures.append("update public.internal_org_people set full_name='Display Name' where id='00000000-0000-0000-0000-0000000003e8';")
fixtures.append("insert into private.employee_directory_details(person_id,first_name,last_name) values('00000000-0000-0000-0000-0000000003e8','Synthetic','Payroll 1');")
fixtures.append("insert into public.internal_org_people(id,full_name,company_key,position_title,is_active) values('00000000-0000-0000-0000-000000009999','Synthetic Payroll 2','mam','Synthetic duplicate',true);")
payload="'"+json.dumps(rows).replace("'","''")+"'"
sql=sql.replace('PAYLOAD',payload).replace('commit;','')
out="\\set ON_ERROR_STOP on\ndo $$begin assert current_database() ~ '^priority_v[0-9]+$', 'Never run fixtures in production'; end$$;\nbegin;\n"+'\n'.join(fixtures)+'\n'+sql.removeprefix('begin;')
out+="""
do $$begin
assert (select count(*)=28 from private.payroll_balance_imports where source_file='synthetic.xlsx');
assert (select count(*)=17 from private.employee_annual_leave_balances where source_import_id is not null);
assert (select count(*)=17 from private.employee_sick_leave_balances where source_import_id is not null);
assert (select count(*)=17 from private.annual_leave_balance_history where source_import_id is not null);
assert (select count(*)=17 from private.sick_leave_balance_history where source_import_id is not null);
assert (select match_status='linked' from private.payroll_balance_imports where employee_name='Synthetic Payroll 1'), 'HR-name match must survive a different display name';
assert (select match_status='unmatched' and person_id is null from private.payroll_balance_imports where employee_name='Synthetic Payroll 2'), 'A duplicate added since preparation must not be synchronized';
end$$;
"""
# Replay the production import body in a second temp staging table to prove idempotency.
out+=sql.removeprefix('begin;').replace('task_payroll_rows','task_payroll_replay').replace('task_payroll_matches','task_payroll_matches_replay')
out+="""
do $$begin
assert (select count(*)=28 from private.payroll_balance_imports where source_file='synthetic.xlsx');
assert (select count(*)=17 from private.annual_leave_balance_history where source_import_id is not null);
assert (select count(*)=17 from private.sick_leave_balance_history where source_import_id is not null);
end$$;
rollback;
"""
pathlib.Path(sys.argv[1]).write_text(out)
