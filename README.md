# Mac Widgets

Painel de widgets inspirado no macOS para a área de trabalho Linux/GNOME.

> **Status atual:** o código deste repositório roda nativamente em Linux com GNOME. A versão Windows ainda precisa de uma adaptação de plataforma; o prompt abaixo orienta essa migração sem quebrar a versão Linux.

## O que o app faz

- Exibe widgets flutuantes na área de trabalho.
- Relógio analógico, digital e fusos horários.
- Calendário.
- Cotações de moedas e criptomoedas com histórico.
- Fotos em slideshow.
- Detecção do vídeo em reprodução no navegador e vídeo fixo do YouTube.
- Integração com reprodução de mídia via MPRIS, incluindo Spotify.
- Atalhos para ferramentas de IA instaladas ou versões web.
- Monitoramento de CPU, memória, disco e bateria.
- Notas rápidas.
- Painel flutuante e configurações acessíveis pelo atalho `Super + W`.

## Arquitetura

- `widgets.py`: backend Python, servidor HTTP local protegido por token e janela GTK/WebKit.
- `web/`: interface HTML, CSS e JavaScript dos widgets e das configurações.
- `extension/`: extensão GNOME Shell para posicionar widgets diretamente na área de trabalho.
- `install.sh`: instalador para Linux/GNOME, incluindo autostart e atalho `Super + W`.

## Requisitos atuais — Linux

- Linux com GNOME Shell.
- Python 3.
- GTK 3, PyGObject e WebKitGTK 4.1.
- D-Bus/MPRIS para os recursos de mídia.
- `gsettings`, usado pelo instalador para registrar o atalho.

Os nomes dos pacotes variam por distribuição. No Ubuntu/Debian, normalmente são necessários:

```bash
sudo apt install python3 python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1
```

## Instalação no Linux/GNOME

```bash
chmod +x install.sh widgets.py
./install.sh
```

Para escolher outro atalho:

```bash
./install.sh '<Super><Shift>w'
```

Depois da instalação, abra **Widgets** pelo menu de aplicativos ou use `Super + W`. As configurações ficam disponíveis em **Configurações dos Widgets**.

## Windows

O instalador `install.sh` não funciona no Windows. A implementação atual também não pode ser executada diretamente no Windows porque contém integrações específicas do Linux/GNOME, como GTK/WebKitGTK, GNOME Shell, D-Bus, `/proc` e `gsettings`.

Para pedir a adaptação e instalação para Windows a um agente de programação, copie o prompt abaixo na raiz deste repositório.

## Prompt para adaptar e instalar no Windows

```text
Você é um engenheiro de software responsável por portar e instalar este projeto no Windows 10/11.

Repositório: mac-widgets
Objetivo: entregar uma versão Windows funcional do painel de widgets, preservando a versão Linux/GNOME existente.

Antes de editar:
1. Leia o README e inspecione todo o código.
2. Identifique as dependências exclusivas de Linux/GNOME: GTK3, WebKitGTK, PyGObject, GNOME Shell, D-Bus/MPRIS, /proc, gsettings, caminhos em ~/.config e o atalho Super+W.
3. Não substitua nem remova o caminho Linux sem necessidade. Faça a implementação Windows em módulos/arquivos próprios e mantenha o comportamento atual no Linux.

Implemente uma adaptação nativa para Windows com estas regras:

- Use Python 3.11+ como base, mantendo o front-end HTML/CSS/JavaScript quando isso reduzir retrabalho.
- Escolha uma camada de janela compatível com Windows, como PySide6 com Qt WebEngine, ou outra alternativa equivalente que permita janela sem moldura, transparente, sempre disponível na área de trabalho e com interação normal.
- Remova do caminho Windows as dependências GTK, WebKitGTK, PyGObject, GNOME Shell, D-Bus, /proc, gsettings e comandos bash.
- Preserve os widgets existentes sempre que possível: relógio, calendário, cotações, fotos, YouTube, mídia, IA, sistema e notas.
- Para dados do sistema, use APIs compatíveis com Windows, preferencialmente psutil e APIs oficiais quando necessário.
- Para mídia, use uma integração compatível com Windows Media Session/Global System Media Transport Controls; se algum recurso não puder ser reproduzido, mostre uma mensagem clara em vez de falhar.
- Troque o atalho Linux Super+W por um atalho global configurável no Windows, com padrão Win+W somente se isso puder ser registrado sem conflito; caso contrário, escolha uma combinação segura e documente-a.
- Use caminhos Windows apropriados, como `%APPDATA%\\mac-widgets` para configuração e fotos, sem gravar em diretórios protegidos.
- Crie um instalador PowerShell `install-windows.ps1` e, se necessário, `uninstall-windows.ps1`.
- O instalador deve verificar Python, criar um ambiente virtual, instalar dependências, validar a execução, criar um atalho no menu Iniciar e oferecer inicialização automática no login de forma reversível.
- Não execute comandos destrutivos, não altere políticas de segurança e não baixe binários de fontes não verificadas.
- Adicione `requirements-windows.txt`, um ponto de entrada Windows claro e documentação de troubleshooting.
- Atualize este README com os requisitos, instalação, desinstalação, atalho padrão, limitações conhecidas e como iniciar o app manualmente.
- Adicione testes ou verificações automatizadas para: carregamento da configuração, criação dos diretórios do usuário, inicialização do backend HTTP local e renderização básica da janela.
- Mantenha o servidor HTTP local limitado a 127.0.0.1 e preserve a proteção por token.
- Não declare suporte Windows concluído se a execução real não tiver sido validada em Windows 10/11.

Ao terminar:
1. Execute os testes e validações disponíveis.
2. Mostre exatamente quais arquivos foram alterados e quais comandos foram executados.
3. Informe qualquer recurso que permaneça somente no Linux.
4. Forneça o comando final de instalação e o comando de desinstalação.
5. Não faça commit, push ou publicação sem autorização explícita do proprietário do repositório.
```

## Segurança e privacidade

O backend usa um servidor HTTP local em `127.0.0.1` e um token temporário para proteger as requisições do front-end. As cotações e alguns dados externos dependem de APIs públicas acessadas pela rede.

## Licença

Nenhuma licença foi definida ainda. Adicione uma licença antes de distribuir o projeto publicamente.
