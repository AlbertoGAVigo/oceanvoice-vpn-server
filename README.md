# OceanVoice OpenVPN Server

Servidor OpenVPN Community para Docker Engine en Linux. El destino es el entorno
`docker-36net` de Portainer. El despliegue inicial instala el servidor y prepara
su PKI. El alta de clientes y las rutas de las sedes se configuran por separado.

## Despliegue

1. Comprueba que el host tiene `/dev/net/tun`, que el puerto UDP elegido esta
   libre y que la subred `10.80.0.0/24` no se solapa con las redes existentes.
2. En Portainer, crea una fuente Git con
   `https://github.com/AlbertoGAVigo/oceanvoice-vpn-server.git`. El repositorio
   es publico y permite lectura sin credenciales. En `docker-36net`, crea el
   stack `oceanvoice-openvpn-server` con el metodo **Repository**, selecciona
   esa fuente y usa `refs/heads/main` y `compose.yaml`.
3. El puerto publicado es `1194/udp`. Si necesitas otro puerto externo en el
   host, configura `OPENVPN_PORT` en las variables del stack. OpenVPN sigue
   escuchando en el puerto 1194 dentro del contenedor.
4. Tras desplegar, revisa que el servicio este en ejecucion y que sus logs
   incluyan `Initialization Sequence Completed`. Comprueba el acceso desde
   Internet con un cliente autorizado cuando este disponible.

## Actualizaciones y estado

Si cambias el Dockerfile o un archivo que se copia a la imagen, incrementa la
etiqueta local de la imagen en compose.yaml para construir la nueva version.
Revisa los cambios en Git y usa **Pull and redeploy** desde el stack en Portainer.
Comprueba los logs despues de cada actualizacion. Conserva el volumen
`oceanvoice-openvpn-pki` en los redeploys. Contiene la CA y las claves privadas,
la CRL y las asignaciones de IP. Haz copias protegidas de ese volumen y limita
el acceso a los administradores del host. La CA se inicializa sin contrasena para
permitir la puesta en marcha del contenedor sin interaccion.

Renueva la CRL antes de que expire. Puedes regenerarla en el contenedor con
`EASYRSA_PKI=/var/lib/openvpn/pki /usr/share/easy-rsa/easyrsa --batch gen-crl`
y comprobar que sea legible por el proceso de OpenVPN.


## Panel web

Configura estas variables en **Environment variables** del stack en Portainer:

| Variable | Valor |
| --- | --- |
| `PANEL_USERNAME` | Usuario del panel, sin dos puntos. |
| `PANEL_PASSWORD` | Contrasena del panel. Guardala en Portainer. |
| `PANEL_HTTP_PORT` | Puerto TCP del host. Predeterminado: `8085`. |
| `PANEL_BIND_IP` | IP del host para escuchar. Predeterminado: `127.0.0.1`. Usa `192.168.0.11` para acceso desde la LAN de administracion. |
| `PANEL_SECOND_BIND_IP` | Segunda IP del host para el mismo puerto. Predeterminado: `127.0.0.2`. En `docker-36net`, usa `192.168.101.11` junto con `192.168.0.11` como IP principal. |

Sin usuario o contrasena, el panel queda bloqueado. El acceso usa autenticacion
HTTP Basic. Para transportar las credenciales cifradas, accede mediante un proxy
HTTPS o un tunel seguro.

### Alta y gestion de Teltonika

1. Introduce nombre y sede en el panel. Modelo y version de RutOS son opcionales.
2. Pulsa **Crear certificado** y descarga el `.ovpn` desde el inventario.
3. En el Teltonika, crea un cliente OpenVPN y selecciona **Upload config file**.
   Importa el perfil, activa la configuracion y guarda los cambios.
4. Prueba con Internet por conexion movil. Revisa en el router
   `Initialization Sequence Completed` y una IP de `10.80.0.0/24`.
   Comprueba tambien la reconexion al recuperar cobertura.

El perfil incluye CA, certificado, clave privada del cliente y `tls-crypt`.
No compartas perfiles entre routers. El endpoint predeterminado es
`vpn.oceanvoice.es:1194/UDP`. En **Configuracion**, introduce el servidor y
puerto que deben aparecer en los perfiles descargados y pulsa **Guardar**.
Se conservan en `panel-settings.json` dentro del volumen PKI y se aplican a
cada nueva descarga, incluidos los certificados que ya existian. Los perfiles
ya importados en los routers deben descargarse e importarse de nuevo.

Si aun no hay ajustes guardados, `VPN_HOST` y `OPENVPN_PORT` proporcionan los
valores iniciales del perfil. Los ajustes guardados desde el panel tienen
prioridad sobre esas variables. El protocolo es UDP. El formulario no cambia
el puerto publicado en Docker ni las reglas NAT: configura esos elementos
por separado para que el servidor sea accesible en el destino elegido.

El panel se organiza en **Monitorizacion**, **Routers y perfiles**,
**Configuracion** y **Guia de conexion**. Las pestanas admiten navegacion con
teclado y conservan la seccion seleccionada en la URL.

El inventario muestra certificados de clientes vigentes, caducados y revocados.
Su estado no indica si el router esta conectado. La revocacion publica una nueva
CRL en el volumen compartido y bloquea nuevas conexiones; una sesion establecida
puede continuar hasta renegociar o desconectarse. El boton **Republicar revocacion**
permite reintentar si fallo la publicacion de la CRL. No se puede descargar un
perfil caducado o revocado. Para sustituirlo, crea otro certificado.

El panel ejecuta Easy-RSA con acceso a la CA: solo debe estar accesible para
administradores. No monta el socket Docker ni requiere modo privilegiado.
`routers.json`, dentro de `oceanvoice-openvpn-pki`, conserva los datos de sede y
equipo. El panel no inicializa ni sustituye la CA existente. Las operaciones de
PKI se serializan mediante `.panel-pki-lock`; no ejecutes Easy-RSA manualmente
mientras el panel este realizando una operacion. Si el proceso termina durante
una operacion, comprueba que ya no hay procesos Easy-RSA activos y revisa el
indice antes de retirar manualmente ese directorio de bloqueo.

La primera fase valida el tunel del router. El acceso a las LAN de las sedes
requiere despues rutas, forwarding y reglas de firewall especificas.

### Inventario de routers y conexiones

La seccion **Routers** muestra todos los clientes dados de alta, su sede, estado
real de conexion, IP VPN actual o ultima conocida, origen publico con puerto,
fecha de ultima conexion y ultima vez visto. OpenVPN escribe un informe cada
10 segundos; el panel guarda las ultimas observaciones en `connections.json`
del volumen persistente, incluso sin navegadores abiertos.

Si el informe tiene mas de 45 segundos o esta incompleto, el estado pasa a
**Sin datos recientes**. El historial comienza al instalar esta version. Las
conexiones que duren menos que el intervalo de muestreo pueden no registrarse.
No es un registro de auditoria completo. Las fechas se muestran en la zona
horaria del navegador. Esta actualizacion reinicia OpenVPN una vez para activar
el informe de estado; conserva CA, certificados, claves y asignaciones del pool.

### IP fijas y grupos de acceso

Cada router recibe una IP fija de `10.80.0.2` a `10.80.0.254`, asociada a su
identidad de certificado en `vpn-addresses.json`. La reserva se conserva en
desconexiones, reinicios y redeploys, y no se libera al revocar el certificado.
No se reciclan IP: esta subred admite 253 reservas de identidad en total. Haz
copia del volumen completo, incluidas las reservas, para poder restaurarlas.
La migracion conserva las direcciones ya asignadas del informe de estado y
`ipp.txt`. El dispositivo existente no necesita otro certificado ni perfil.
Si sustituyes su certificado creando otra alta, se trata de una identidad nueva.

En **Configuracion → Comunicacion entre dispositivos VPN** puedes elegir:

- **Aislados** (predeterminado): no se permite comunicacion entre dispositivos.
- **Todos entre si**: permite comunicacion entre todas las identidades vigentes.
- **Grupos: maestro e hijos**: cada grupo tiene nombre, un maestro y varios
  hijos seleccionados del inventario. Maestro e hijo pueden iniciar conexiones
  entre si, en ambos sentidos. El grupo no permite conexiones entre sus hijos.

Los permisos de varios grupos se suman. No hay permisos transitivos: compartir
maestro no autoriza a los hijos entre si. Si un hijo tambien es maestro en otro
grupo, se permiten las conexiones explicitamente definidas por ese otro grupo.
Un maestro con servicios de proxy o forwarding propios puede reenviar trafico;
es necesario administrar tambien ese equipo si no debe ofrecer ese servicio.
El firewall del equipo destino puede bloquear servicios aunque la VPN permita
la comunicacion. Estas reglas solo cubren las IP VPN, no las LAN de las sedes.

El panel guarda `access-policy.json`; un supervisor del servidor aplica las
reglas nftables de forma atomica cada dos segundos y confirma el resultado en
`access-applied.json`. El panel distingue **guardado** de **aplicado**. Retirar
un grupo bloquea tambien sus flujos existentes, sin reiniciar OpenVPN. Si el
supervisor no puede aplicar las reglas, detiene la VPN para no mantener acceso
con una politica obsoleta. La tabla `inet oceanvoice_vpn` vive dentro del
contenedor: no se modifica el firewall del host. El panel sigue sin capacidades
de red ni acceso al socket Docker.

OpenVPN usa CCD para las direcciones fijas, sin pool dinamico ni
`client-to-client`, de manera que el trafico entre clientes pasa por nftables.
`learn-address` valida la IP de origen contra la identidad autenticada para
evitar que un cliente suplante a otro. Los certificados revocados o caducados
se excluyen de las reglas aunque sigan referenciados en un grupo guardado.

### Prueba de integracion aislada

`panel/integration.test.mjs` se ejecuta dentro de la imagen del panel, desde
`/app`, copiando primero ese archivo al contenedor de pruebas. Genera una CA
desechable en `/tmp`, sin montar el volumen de produccion. Comprueba emision,
inventario, duplicados, perfil, revocacion, rechazo con CRL, autenticacion y
proteccion de las operaciones POST. Usa solo Docker remoto `docker36` para las
pruebas en esta maquina. La prueba de conexion movil necesita un router real.

`python -m unittest discover -s tests -p test_vpn_policy.py` comprueba reservas,
antisuplantacion y permisos de grupos. `tests/policy_smoke.py` usa una imagen
de pruebas `oceanvoice/openvpn-server-test:20261123` construida con el Dockerfile
del servidor y crea en `docker36` una red y cuatro contenedores desechables con
etiquetas de propiedad. Prueba trafico TCP real entre tres clientes OpenVPN:
aislamiento, maestro/hijos, bloqueo entre hijos, modo todos y retirada de acceso.
No monta el volumen PKI de produccion ni publica puertos.
