# Hangar API (ASP.NET Core 10). Build context: apps/api.
# docker build -t hangar-api:<version> apps/api
FROM mcr.microsoft.com/dotnet/sdk:10.0.402@sha256:0d99ebf1ccad15037b5c98c9fe8979d6b8dbac23812feae2277a0b277b5c5ffa AS build
WORKDIR /src
COPY Directory.Build.props ./
COPY src/Hangar.Core/Hangar.Core.csproj src/Hangar.Core/
COPY src/Hangar.Api/Hangar.Api.csproj src/Hangar.Api/
RUN dotnet restore src/Hangar.Api/Hangar.Api.csproj
COPY src/ src/
RUN dotnet publish src/Hangar.Api/Hangar.Api.csproj -c Release --no-restore -o /out /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0.13@sha256:d5633778c754e89a386882eddf8dbee6942447a8a4b8267c19cf1e1158d0b0ac
# uid 10001 matches the asset validator: both own the shared file store (quarantine/spool/sounds/images).
RUN groupadd --gid 10001 hangar && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hangar
WORKDIR /app
COPY --from=build /out .
USER 10001
ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_URLS=http://127.0.0.1:8080 \
    DOTNET_gcServer=0 \
    Hangar__DataDirectory=/data \
    Hangar__Storage__Root=/data/files
# `--migrate` applies EF migrations + bootstrap, then exits (run as a one-off job before replacing the API).
ENTRYPOINT ["dotnet", "Hangar.Api.dll"]
