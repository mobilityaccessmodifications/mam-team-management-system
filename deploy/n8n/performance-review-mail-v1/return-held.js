const previous = $('Validate Payload').first().json;
return [{json: previous.response || {ok: false, status: 'held', ...previous.binding}}];
