FROM mongo:latest

COPY ./random.key /app/repl.key
COPY ./init-repl-set.sh /docker-entrypoint-initdb.d/init-repl-set.sh
RUN chmod 400 /app/repl.key && chown 999:999 /app/repl.key

ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 27017
CMD ["mongod", "--bind_ip_all", "--replSet", "rs0", "--keyFile", "/app/repl.key"]
