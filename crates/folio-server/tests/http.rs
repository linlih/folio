//! The relay over real HTTP and WebSocket, driven by the app's own client.

use std::sync::mpsc;
use std::time::Duration;

use folio_sync::client::Transport;
use folio_sync::crypto::{wrap, WorkspaceKey};
use folio_sync::http::Http;
use folio_sync::protocol::PushItem;
use folio_sync::relay::Relay;
use folio_sync::SyncError;

const TOKEN: &str = "test-token-0123456789";

fn start() -> String {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            let server = folio_server::Server::new(Relay::open_in_memory().unwrap(), TOKEN);
            axum::serve(listener, folio_server::router(server)).await.unwrap();
        });
    });
    format!("http://{}", rx.recv().unwrap())
}

#[test]
fn key_push_pull_and_live() {
    let base = start();
    let a = Http::new(&base, TOKEN, "ws1", "device-a");
    let b = Http::new(&base, TOKEN, "ws1", "device-b");

    assert!(a.get_key().unwrap().is_none());
    let wrapped = wrap(&WorkspaceKey::generate(), "pass", (1024, 1, 1)).unwrap();
    a.put_key(&wrapped).unwrap();
    assert!(matches!(b.put_key(&wrapped), Err(SyncError::Conflict(_))));
    assert_eq!(b.get_key().unwrap().unwrap().salt, wrapped.salt);

    // B listens; A pushes; B hears the new head and pulls.
    let (tx, rx) = mpsc::channel();
    let listener = b.clone();
    std::thread::spawn(move || {
        let _ = listener.listen(|head| {
            let _ = tx.send(head);
        });
    });
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 0);
    let item = PushItem { doc: "tag".into(), blob: folio_sync::crypto::b64(b"sealed") };
    assert_eq!(a.push(&[item.clone(), item]).unwrap(), 2);
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 2);
    let pulled = b.pull(0, 10).unwrap();
    assert_eq!((pulled.head, pulled.updates.len()), (2, 2));
    assert_eq!(pulled.updates[0].device, "device-a");
    assert_eq!(b.pull(1, 10).unwrap().updates.len(), 1);
}

#[test]
fn wrong_token_is_refused() {
    let base = start();
    let bad = Http::new(&base, "nope-nope-nope-nope", "ws1", "device-a");
    assert!(matches!(bad.get_key(), Err(SyncError::Unauthorized)));
    assert!(matches!(bad.pull(0, 1), Err(SyncError::Unauthorized)));
    let unknown = Http::new(&base, TOKEN, "missing", "device-a");
    assert!(matches!(unknown.pull(0, 1), Err(SyncError::NotFound(_))));
}

/// Two devices' stores syncing through the server, as the app does.
#[test]
fn two_stores_sync_through_the_server() {
    use folio_core::CardKind;
    use folio_store::Store;
    use folio_sync::client::Engine;
    use folio_sync::crypto::Keys;
    use std::sync::Mutex;

    let base = start();
    let key = WorkspaceKey::generate();
    let engine = Engine::new("ws2", Keys::derive(&key));
    let (da, db) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let a = Mutex::new(Store::open(da.path()).unwrap());
    let b = Mutex::new(Store::open(db.path()).unwrap());
    let ta = Http::new(&base, TOKEN, "ws2", "device-a");
    let tb = Http::new(&base, TOKEN, "ws2", "device-b");
    ta.put_key(&wrap(&key, "passphrase", (1024, 1, 1)).unwrap()).unwrap();

    let id = a.lock().unwrap().create_card(CardKind::Note, "从 A 来的卡片", 1).unwrap();
    a.lock().unwrap().queue_everything(1).unwrap();
    assert!(engine.sync(&a, &ta).unwrap().pushed >= 1);
    let report = engine.sync(&b, &tb).unwrap();
    assert!(report.applied.iter().any(|x| x.doc == id));
    assert_eq!(b.lock().unwrap().card_summary(&id).unwrap().title, "从 A 来的卡片");

    // And back: B trashes it, A sees it in the trash.
    b.lock().unwrap().trash_card(&id, 2).unwrap();
    engine.sync(&b, &tb).unwrap();
    engine.sync(&a, &ta).unwrap();
    assert_eq!(a.lock().unwrap().list_trash(10).unwrap().len(), 1);
    // Nothing more to do on either side.
    let quiet = engine.sync(&a, &ta).unwrap();
    assert_eq!((quiet.pushed, quiet.applied.len()), (0, 0));
    assert_eq!(quiet.acks_error, None);

    // Each knows the version the other has.
    engine.sync(&b, &tb).unwrap();
    engine.sync(&a, &ta).unwrap();
    let vv = |b: Option<Vec<u8>>| b.map(|b| loro::VersionVector::decode(&b).unwrap());
    let va = vv(Some(a.lock().unwrap().doc_version(&id, folio_core::DocKind::Card).unwrap()));
    assert_eq!(vv(b.lock().unwrap().device_ack(&id, "device-a").unwrap()), va);
    assert_eq!(vv(a.lock().unwrap().device_ack(&id, "device-b").unwrap()), va);

    // Names are sealed; the list has both devices.
    engine.set_device_name(&ta, "Lin 的 Mac").unwrap();
    let devices = engine.devices(&tb).unwrap();
    let names: Vec<_> = devices.iter().map(|d| (d.id.as_str(), d.name.as_deref())).collect();
    assert!(names.contains(&("device-a", Some("Lin 的 Mac"))), "{names:?}");
    assert!(names.contains(&("device-b", None)), "{names:?}");
    let other = Engine::new("ws2", Keys::derive(&WorkspaceKey::generate()));
    assert!(other.devices(&tb).unwrap().iter().all(|d| d.name.is_none()), "a wrong key opens no name");
}
