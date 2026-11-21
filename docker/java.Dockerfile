# syntax=docker/dockerfile:1
#
# Constrói as duas calculadoras Java da Receita direto dos repositórios oficiais no GitHub.
# O banco SQLite (calculadora-pro.db) é gerado uma vez, com as migrações Flyway do regime regular,
# e copiado para as duas imagens (o Simples Nacional usa o mesmo banco).
#
# Alvos: regime-geral e simples-nacional (os dois exigem Java 25).

ARG RG_REPO=https://github.com/ReceitaFederal/calculadora-rtc-regime-regular.git
ARG RG_REF=main
ARG SN_REPO=https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional.git
ARG SN_REF=main

# ---------------------------------------------------------------- código-fonte
FROM alpine/git:latest AS fonte-rg
ARG RG_REPO
ARG RG_REF
RUN git clone --depth 1 --branch "$RG_REF" "$RG_REPO" /src

FROM alpine/git:latest AS fonte-sn
ARG SN_REPO
ARG SN_REF
RUN git clone --depth 1 --branch "$SN_REF" "$SN_REPO" /src

# ---------------------------------------------------------------- banco de dados compartilhado
FROM maven:3.9-eclipse-temurin-25 AS banco
WORKDIR /src
COPY --from=fonte-rg /src .
RUN --mount=type=cache,target=/root/.m2 \
    mkdir -p calculadora/db && \
    mvn -B --no-transfer-progress flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf && \
    ls -lh calculadora/db/calculadora-pro.db

# ---------------------------------------------------------------- builds
FROM maven:3.9-eclipse-temurin-25 AS build-rg
WORKDIR /src
COPY --from=fonte-rg /src .
RUN --mount=type=cache,target=/root/.m2 mvn -B --no-transfer-progress -DskipTests package

FROM maven:3.9-eclipse-temurin-25 AS build-sn
WORKDIR /src
COPY --from=fonte-sn /src .
RUN --mount=type=cache,target=/root/.m2 mvn -B --no-transfer-progress -DskipTests package

# ---------------------------------------------------------------- imagens finais
FROM eclipse-temurin:25-jre AS regime-geral
WORKDIR /app
COPY --from=build-rg /src/target/api-regime-geral.jar app.jar
COPY --from=banco /src/calculadora/db/calculadora-pro.db calculadora/db/calculadora-pro.db
ENV SPRING_PROFILES_ACTIVE=offline
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]

FROM eclipse-temurin:25-jre AS simples-nacional
WORKDIR /app
COPY --from=build-sn /src/target/api-simples-nacional.jar app.jar
COPY --from=banco /src/calculadora/db/calculadora-pro.db calculadora/db/calculadora-pro.db
ENV SPRING_PROFILES_ACTIVE=offline
EXPOSE 8082
ENTRYPOINT ["java", "-jar", "app.jar"]
