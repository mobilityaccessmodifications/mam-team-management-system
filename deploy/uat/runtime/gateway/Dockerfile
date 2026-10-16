ARG UAT_BASE_IMAGE
FROM ${UAT_BASE_IMAGE}
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY uat.conf.template /etc/nginx/templates/uat.conf.template
COPY entrypoint.sh /usr/local/bin/uat-gateway-entrypoint
RUN chmod 0555 /usr/local/bin/uat-gateway-entrypoint
USER 101:101
EXPOSE 8081
ENTRYPOINT ["/bin/sh", "/usr/local/bin/uat-gateway-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
